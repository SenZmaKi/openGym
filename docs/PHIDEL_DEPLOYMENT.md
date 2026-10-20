# Phidel deployment

Production uses the existing Dokploy Compose service `opengym-server-t7dhkk`
(`BOF2WZ2mSCeMOWbYrp2YO`), connected to `SenZmaKi/openGym`, branch `main`,
path `./docker-compose.phidel.yml`. Dokploy builds the API, web and MCP images from
this checkout. No registry credentials are required. Containers are replaced after
images build; a brief API interruption is possible. Health checks run every 15 seconds
(with a 10-second startup period), overriding the upstream five-minute interval that
otherwise leaves Traefik without a route while containers are starting.

The application stores JSON documents and uploads under `/data`. The four existing
application/media/provider volumes are explicitly named **external** volumes. Missing
volumes make deployment fail rather than initialize an empty account store. Never use
`down --volumes`, fresh volumes, isolated deployment volumes, or a different volume name.
The new MCP auth database has its own persistent volume and secret.

Existing runtime environment, RP_ID, ORIGIN, session secret, passkeys and hostname must
be retained. Additional runtime values are `MCP_PUBLIC_URL` (the HTTPS MCP origin) and
`MCP_AUTH_SECRET` (a persistent random secret). No production secrets belong in Git.

The `deploy-dokploy` workflow follows a successful Tests workflow on main. It checks that
the tested SHA is still current and triggers/polls this existing Compose service. The
manual workflow_dispatch path is an explicit operator override. Required repository
secrets: DOKPLOY_URL, DOKPLOY_API_KEY and DOKPLOY_COMPOSE_ID. Dokploy auto-deploy is
disabled so its GitHub webhook does not bypass the test gate.

Before the first migration, back up every file in the application data volume, verify
file hashes and JSON readability, record profile counts and the current Compose config.
Keep the backup outside the repository with owner-only access. After deployment verify
that the running API mounts the same volume, account/passkey and workout documents
retain their content, the site serves HTTPS, and the MCP health/auth metadata works.

Rollback: restore the saved raw Compose configuration/environment on the **same**
Dokploy service, with the previous upstream images (or their recorded digests), and
redeploy using the same volumes. Do not restore a pre-migration data backup over newer
workouts unless recovering actual corruption and deliberately accepting that data loss.

The public MCP connection URL is `https://opengym-mcp.phidel.dev/mcp`. Authorize by
creating a one-time pairing code in OpenGym and entering it on the MCP sign-in page.
