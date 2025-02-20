import path from "path";
import { VisibleError } from "../../error.js";
import type { Program } from "../program.js";
import type {
  SlsNextjsMetadata,
  SsrSiteMetadata,
  StaticSiteMetadata,
} from "../../constructs/Metadata.js";

type BIND_REASON =
  | "init"
  | "metadata_updated"
  | "secrets_updated"
  | "iam_expired";

class OutdatedMetadataError extends Error {}

export const bind = (program: Program) =>
  program
    .command(
      ["bind <command..>", "env <command..>"],
      "Bind your app's resources to a command",
      (yargs) =>
        yargs
          .array("command")
          .example(`sst bind "vitest run"`, "Bind your resources to your tests")
          .example(
            `sst bind "tsx scripts/myscript.ts"`,
            "Bind your resources to a script"
          ),
      async (args) => {
        const { spawn } = await import("child_process");
        const kill = await import("tree-kill");
        const { useProject } = await import("../../project.js");
        const { useBus } = await import("../../bus.js");
        const { useIOT } = await import("../../iot.js");
        const { Colors } = await import("../colors.js");
        const { Logger } = await import("../../logger.js");

        if (args._[0] === "env") {
          Colors.line(
            Colors.warning(
              `Warning: ${Colors.bold(
                `sst env`
              )} has been renamed to ${Colors.bold(`sst bind`)}`
            )
          );
        }

        await useIOT();
        const bus = useBus();
        const project = useProject();
        const command = args.command?.join(" ");
        const isSite = await isRunningInSite();
        let p: ReturnType<typeof spawn> | undefined;
        let timer: ReturnType<typeof setTimeout> | undefined;
        let siteConfigCache:
          | Awaited<ReturnType<typeof parseSiteMetadata>>
          | undefined;

        // Handle missing command
        if (!command) {
          throw new VisibleError(
            `Command is required, e.g. sst bind ${
              isSite ? "next dev" : "vitest run"
            }`
          );
        }

        // Bind script
        if (!isSite) {
          Logger.debug("Running in script mode.");
          return await bindScript();
        }

        // Bind site
        try {
          await bindSite("init");
        } catch (e: any) {
          // Bind script (fallback)
          if (e instanceof OutdatedMetadataError) {
            Colors.line(
              Colors.warning(
                "Warning: This was deployed with an old version of SST. Run `sst dev` or `sst deploy` to update."
              )
            );
            return await bindScript();
          }
          throw e;
        }

        bus.subscribe("stacks.metadata.updated", () =>
          bindSite("metadata_updated")
        );
        bus.subscribe("stacks.metadata.deleted", () =>
          bindSite("metadata_updated")
        );
        bus.subscribe("config.secret.updated", (payload) => {
          const secretName = payload.properties.name;
          if (!(siteConfigCache?.secrets || []).includes(secretName)) return;

          Colors.line(
            `\n`,
            `SST secrets have been updated. Restarting \`${command}\`...`
          );
          bindSite("secrets_updated");
        });

        async function isRunningInSite() {
          const { existsAsync } = await import("../../util/fs.js");
          const { readFile } = await import("fs/promises");
          const SITE_CONFIGS = [
            { file: "next.config", multiExtension: true },
            { file: "astro.config", multiExtension: true },
            { file: "remix.config", multiExtension: true },
            { file: "svelte.config", multiExtension: true },
            { file: "gatsby-config", multiExtension: true },
            { file: "angular.json" },
            { file: "ember-cli-build.js" },
            {
              file: "vite.config",
              multiExtension: true,
              match: /solid-start|plugin-vue|plugin-react|@preact\/preset-vite/,
            },
            { file: "package.json", match: /react-scripts/ }, // CRA
            { file: "index.html" }, // plain HTML
          ];
          const results = await Promise.all(
            SITE_CONFIGS.map((site) => {
              const files = site.multiExtension
                ? [".js", ".cjs", ".mjs", ".ts"].map(
                    (ext) => `${site.file}${ext}`
                  )
                : [site.file];
              return files.map(async (file) => {
                const exists = await existsAsync(file);
                if (!exists) return false;

                if (site.match) {
                  const content = await readFile(file);
                  return content.toString().match(site.match);
                }

                return true;
              });
            }).flat()
          );

          return results.some(Boolean);
        }

        async function bindSite(reason: BIND_REASON) {
          // Get metadata
          const siteMetadata = await getSiteMetadataUntilAvailable();
          const siteConfig = await parseSiteMetadata(siteMetadata!);

          // Handle rebind due to metadata updated
          if (reason === "metadata_updated") {
            if (areEnvsSame(siteConfig.envs, siteConfigCache?.envs || {}))
              return;
            Colors.line(
              `\n`,
              `SST resources have been updated. Restarting \`${command}\`...`
            );
          }
          siteConfigCache = siteConfig;

          // Assume function's role credentials
          if (siteConfig.role) {
            const credentials = await assumeSsrRole(siteConfig.role);
            if (credentials) {
              // refresh crecentials 1 minute before expiration
              const expireAt = credentials.Expiration!.getTime() - 60000;
              clearTimeout(timer);
              timer = setTimeout(() => {
                Colors.line(
                  `\n`,
                  `Your AWS session is about to expire. Creating a new session and restarting \`${command}\`...`
                );
                bindSite("iam_expired");
              }, expireAt - Date.now());

              await runCommand({
                ...siteConfig.envs,
                AWS_ACCESS_KEY_ID: credentials!.AccessKeyId,
                AWS_SECRET_ACCESS_KEY: credentials!.SecretAccessKey,
                AWS_SESSION_TOKEN: credentials!.SessionToken,
              });
              return;
            }
          }

          // Fallback to use local IAM credentials
          await runCommand({
            ...siteConfig.envs,
            ...(await localIamCredentials()),
          });
        }

        async function bindScript() {
          const { Config } = await import("../../config.js");
          await runCommand({
            ...(await Config.env()),
            ...(await localIamCredentials()),
          });
        }

        async function getSiteMetadataUntilAvailable() {
          const { createSpinner } = await import("../spinner.js");
          const spinner = createSpinner({});
          while (true) {
            const data = await getSiteMetadata();

            // Handle site metadata not found
            if (!data) {
              spinner.start("Make sure `sst dev` is running...");
              await new Promise((resolve) => setTimeout(resolve, 1000));
              continue;
            }

            spinner.isSpinning && spinner.stop().clear();

            return data;
          }
        }

        async function getSiteMetadata() {
          const { metadata } = await import("../../stacks/metadata.js");
          const metadataData = await metadata();
          return Object.values(metadataData)
            .flat()
            .filter(
              (
                c
              ): c is
                | SsrSiteMetadata
                | StaticSiteMetadata
                | SlsNextjsMetadata =>
                [
                  "StaticSite",
                  "NextjsSite",
                  "AstroSite",
                  "RemixSite",
                  "SolidStartSite",
                  "SvelteKitSite",
                  "SlsNextjsSite",
                ].includes(c.type)
            )
            .find((c) => {
              // Handle metadata prior to SST v2.3.0 doesn't have path
              const isSsr =
                c.type !== "StaticSite" && c.type !== "SlsNextjsSite";
              if (
                !c.data.path ||
                (isSsr && !c.data.server) ||
                (!isSsr && !c.data.environment)
              ) {
                throw new OutdatedMetadataError();
              }

              return (
                path.resolve(project.paths.root, c.data.path) === process.cwd()
              );
            });
        }

        async function parseSiteMetadata(
          metadata: SlsNextjsMetadata | StaticSiteMetadata | SsrSiteMetadata
        ) {
          const { LambdaClient, GetFunctionCommand } = await import(
            "@aws-sdk/client-lambda"
          );
          const { useAWSClient } = await import("../../credentials.js");

          const isBindSupported =
            metadata.type !== "StaticSite" && metadata.type !== "SlsNextjsSite";

          // Handle StaticSite
          if (!isBindSupported) {
            return { envs: metadata.data.environment };
          }

          // Get function details
          const lambda = useAWSClient(LambdaClient);
          const { Configuration: functionConfig } = await lambda.send(
            new GetFunctionCommand({
              FunctionName: metadata.data.server,
            })
          );

          return {
            role: functionConfig?.Role!,
            envs: functionConfig?.Environment?.Variables || {},
            secrets: metadata.data.secrets,
          };
        }

        async function assumeSsrRole(roleArn: string) {
          const { STSClient, AssumeRoleCommand } = await import(
            "@aws-sdk/client-sts"
          );
          const { useAWSClient } = await import("../../credentials.js");
          const sts = useAWSClient(STSClient);
          const assumeRole = async (duration: number) => {
            const { Credentials: credentials } = await sts.send(
              new AssumeRoleCommand({
                RoleArn: roleArn,
                RoleSessionName: "dev-session",
                DurationSeconds: duration,
              })
            );
            return credentials;
          };

          // Assue role with max duration first. This can fail if chaining roles, or if
          // the role has a max duration set. If it fails, assume role with 1 hour duration.
          let err: any;
          try {
            return await assumeRole(43200);
          } catch (e) {
            err = e;
          }

          if (
            err.name === "ValidationError" &&
            err.message.startsWith("The requested DurationSeconds exceeds")
          ) {
            try {
              return await assumeRole(3600);
            } catch (e) {
              err = e;
            }
          }

          Colors.line(
            "Using local IAM credentials since `sst dev` is not running."
          );
          Logger.debug(`Failed to assume ${roleArn}.`, err);
        }

        async function localIamCredentials() {
          const { useAWSCredentials } = await import("../../credentials.js");
          const credentials = await useAWSCredentials();
          return {
            AWS_ACCESS_KEY_ID: credentials.accessKeyId,
            AWS_SECRET_ACCESS_KEY: credentials.secretAccessKey,
            AWS_SESSION_TOKEN: credentials.sessionToken,
          };
        }

        async function runCommand(envs: Record<string, string | undefined>) {
          Colors.gap();

          if (p) {
            p.removeAllListeners("exit");
            // Note: calling p.kill() does not kill child processes. And in the
            // cases of Next.js and CRA, servers are child processes. Need to
            // kill the entire process tree to free up port ie. 3000.
            await new Promise((resolve, reject) => {
              kill.default(p?.pid!, (error) => {
                if (error) {
                  return reject(error);
                }
                resolve(true);
              });
            });
          }

          p = spawn(command!, {
            env: {
              ...process.env,
              ...envs,
              AWS_REGION: project.config.region,
            },
            stdio: "inherit",
            shell: true,
          });

          p.on("exit", (code) => {
            process.exit(code || 0);
          });
        }

        function areEnvsSame(
          envs1: Record<string, string | undefined>,
          envs2: Record<string, string | undefined>
        ) {
          return (
            Object.keys(envs1).length === Object.keys(envs2).length &&
            Object.keys(envs1).every((key) => envs1[key] === envs2[key])
          );
        }
      }
    )
    .strict(false);
