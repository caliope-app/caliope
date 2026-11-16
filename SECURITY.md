# Security

Report a security problem privately: open the **Security** tab of this repository on GitHub and click **Report a vulnerability**. Please don't open a public issue for it.

Caliope runs commands and edits files on your PC with the permissions you give it. Approval modes and folder trust decide what runs without asking; they are not a sandbox.

An update from inside Caliope installs only when the release's `manifest.json` carries a valid signature for the key in `server/config.js`, and the zip matches the SHA-256 in that manifest. The install line checks the SHA-256 only. Each release zip also has a build provenance attestation: `gh attestation verify Caliope-windows-x64.zip --repo caliope-app/caliope`.
