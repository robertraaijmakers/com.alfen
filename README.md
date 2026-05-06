# Alfen
This app adds support for the Alfen charger (single and duo connection) and will make sure the charger is shown as chargepoint in Homey Energy. The app supports a couple of basic actions to regulate the way of charging. Please note that updating these settings through Homey might cause issues with your charge management system and is at own risk!

*Please note:* for this app to work your Homey and the Charger must be connected to the same SUBNET. So if you have different subnets within your household, make sure the charger and your Homey are in the same. Otherwise you cannot login, this is a limitation/security measure on Alfen side.

*Please note:* Alfen doesn't support multiple connections through the WebAPI. That means that you will encounter errors with refreshing and setting data once you have your Alfen app open on your smartphone simultanously when running this app on your Homey. Make sure to close your smartphone app when submitting changes and refreshing data.

More information can be found here: https://robertraaijmakers.github.io/com.alfen/

## Local Property Discovery (Debug)

Use the included utility to probe unknown Web API property IDs and diff snapshots before/after changes in Eve Connect.

### Store Credentials Once

To avoid typing IP/username/password in every command:

1. Copy `.alfen-debug.example.json` to `.alfen-debug.json`
2. Fill in your charger credentials
3. Run commands without `--ip`, `--user`, `--pass`

Example:

```bash
cp .alfen-debug.example.json .alfen-debug.json
```

Then:

```bash
npm run debug:props -- --current-scan
```

Notes:

- `.alfen-debug.json` is ignored by git.
- You can also use env vars: `ALFEN_IP`, `ALFEN_USER`, `ALFEN_PASS`.
- Use `--profile <file>` if you want a different credentials file.

### Why this helps

- You can test candidate ids such as `2188_0` and `8109_2` without changing app capabilities first.
- You can detect which properties change when toggling schedule, changing time slots, or changing max charge power.
- You can import failed ids directly from an exported charger log.

### Quick usage

Run from the project root:

```bash
npm run debug:props -- --ip <charger-ip> --user <username> --pass <password> --ids 2188_0,8109_2
```

Probe a likely schedule range:

```bash
npm run debug:props -- --ip <charger-ip> --user <username> --pass <password> --range 8100-8110 --indexes 0,1,2
```

Extract and probe ids seen in your export file:

```bash
npm run debug:props -- --ip <charger-ip> --user <username> --pass <password> --extract-failed "MyEve - Export - 1774625812615.txt"
```

### Recommended workflow to map unknown settings

1. Capture baseline snapshot:

```bash
npm run debug:props -- --ip <charger-ip> --user <username> --pass <password> --schedule-probe --out before.json
```

2. In Eve Connect, change exactly one setting (for example schedule on/off).
3. Capture second snapshot:

```bash
npm run debug:props -- --ip <charger-ip> --user <username> --pass <password> --schedule-probe --out after.json
```

4. Diff both snapshots:

```bash
node scripts/alfen-property-explorer.js --diff before.json after.json
```

Repeat for one change at a time (max power, day slot start/end, slot current) to infer property meaning.

### Notes

- Keep Eve Connect closed while probing to avoid session conflicts.
- The tool supports read operations and optional write operations (`--set-current`, `--set-prop`).
- Use `--help` to see all options.