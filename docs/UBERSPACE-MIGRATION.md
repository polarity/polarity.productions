# Uberspace Migration

Runbook for moving `https://polarity.productions/` from Hetzner to the Uberspace 7 account `poliprod` on `adhara.uberspace.de`.

## Account

- User: `poliprod`
- SSH/SFTP host: `adhara.uberspace.de`
- Staging URL: `https://poliprod.uber.space/`
- Webroot: `/var/www/virtual/poliprod/html`
- MySQL user/database: `poliprod`
- Dispenser database: `poliprod_dispenser`

DNS records for cutover:

```text
A     185.26.156.15
AAAA  2a00:d0c0:200:0:3420:57ff:fe47:fe52
MX    adhara.uberspace.de
```

Only set the MX record if mail for `polarity.productions` should be handled by this Uberspace account.

Verify the first SSH connection against one of these fingerprints:

```text
ED25519  SHA256:KjY26/Do1ueu41aBM8VeHNiFfG/XawvQbipMVFSfhyE
RSA      SHA256:zTqQbp7KEUYoLsx3B7rGnEpftwaLyARpeWILbOTzU2A
```

## Local Config

Install dependencies once:

```powershell
npm install
```

Create ignored config files:

```powershell
New-Item -ItemType Directory -Force .buildt
Copy-Item sftp-config.example.json .buildt/sftp-config.json
Copy-Item uberspace-config.example.json .buildt/uberspace-config.json
```

Adjust `privateKeyPath`, `passphrase`, or use `password` in the ignored config if needed.

## Assemble And Deploy

Build the combined public webroot:

```powershell
npm run assemble
```

This creates `public/` with:

- `/` from `F:\GitHub\polarity.productions`
- `/polarity-res/` from `F:\GitHub\webpage.polarity-res`
- `/polarity-md/` from `F:\GitHub\webpage.polarity-md`
- `/polarity-sc/` from `F:\GitHub\webpage.polarity-sc-dark`
- `/spectrogram/` from `F:\GitHub\app.spectrogram`
- `/spectrum/` from `F:\GitHub\app.spectrum.analyzer`
- `/vectorscope/` from `F:\GitHub\app.vectorscope`
- `/dispenser/` from `F:\GitHub\app.dispenser\dispenser`

Excluded from deploy: repo metadata, `node_modules`, local configs, Dispenser `config.php`, Dispenser `config.sample.php`, and Dispenser `uploads/`.

Preview and deploy:

```powershell
npm run deploy:sftp:dry-run
npm run deploy:sftp
```

Before the first deploy to Uberspace, delete `.buildt/sftp-deploy-manifest.json` if it exists from a different target.

## Uberspace Setup

Check the remote environment:

```powershell
npm run uberspace:check
```

Prepare webroot, PHP, domain registration, and the Dispenser database:

```powershell
npm run uberspace:setup
```

Upload generated Dispenser runtime config:

```powershell
npm run uberspace:dispenser:config
```

The generated config keeps the existing local secrets but changes:

- DB host/user/password/database for Uberspace
- Patreon callback to `https://polarity.productions/dispenser/callback.php`
- Google callback to `https://polarity.productions/dispenser/callback_google.php`

Update those callback URLs in the Patreon and Google provider dashboards before final production validation.

## Dispenser Data

Export local/current Dispenser MySQL data:

```powershell
npm run uberspace:db:export
```

If the local config is somewhere else:

```powershell
$env:DISPENSER_CONFIG_PATH = 'F:\GitHub\app.dispenser\dispenser\config.php'
npm run uberspace:db:export
```

Import into Uberspace:

```powershell
npm run uberspace:db:import
npm run uberspace:db:counts
```

Upload existing Dispenser uploads separately:

```powershell
npm run uberspace:dispenser:uploads
npm run uberspace:permissions
```

## Validation

Validate staging before DNS cutover:

```powershell
npm run uberspace:validate
```

After DNS cutover:

```powershell
$env:VALIDATE_BASE_URL = 'https://polarity.productions'
npm run uberspace:validate
```

Also manually verify:

- Dispenser admin login at `/dispenser/admin/`
- Patreon login and callback
- Google/YouTube login and callback
- at least one gated link and one Bandcamp claim flow
- Uberspace logs under `/home/poliprod/logs`

## Notes

- Do not run background dev or app servers for this migration.
- Keep `https://polarity.productions/dispenser/` canonical; do not redirect Dispenser to another domain.
- Uberspace serves public files from `/var/www/virtual/poliprod/html`; `/home/poliprod/html` points there.
- If `www.polarity.productions` should also work, add it explicitly with `uberspace web domain add www.polarity.productions` and add the same DNS records for `www`.
