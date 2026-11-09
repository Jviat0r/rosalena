# Signing and notarizing the macOS build

This exists because the macOS artifact is the one part of the release pipeline that
cannot be tested from this machine. Everything below runs on a macOS host. Nothing here
has been executed yet — no macOS artifact exists, signed or otherwise. Read this as the
runbook for the first signed release, not as a record of a passing run.

## The two paths

| Path | Who it is for | What happens |
| --- | --- | --- |
| Unsigned (`identity: null`, the committed default) | anyone today, and CI runs without Apple secrets | `.dmg`/`.zip` build fine. Gatekeeper quarantine marks the app "damaged" or "unidentified developer" until the user runs `xattr -dr com.apple.quarantine`. |
| Signed + notarized | a public release | Developer ID Application certificate signs the app, Apple's notary service scans it, the ticket is stapled to the `.app`, Gatekeeper lets it open normally. |

Both are the same build command; only the environment changes.

```bash
# unsigned
node packaging/release/build.mjs mac

# signed (needs a Developer ID certificate in the login keychain)
node packaging/release/build.mjs mac --sign "Developer ID Application: Your Name (TEAMID)"
```

`build.mjs` turns `--sign` into `-c.mac.identity=<id> -c.mac.notarize=true` and sets
`CSC_IDENTITY_AUTO_DISCOVERY=true`. Without `--sign` it passes `-c.mac.identity=null` and
`-c.mac.notarize=false`, so the committed config can never accidentally sign with
whatever certificate happens to be in the keychain.

## What signing requires

1. **An Apple Developer Program membership** ($99/year). A free Apple ID cannot issue a
   Developer ID certificate, so notarization is impossible without it.
2. **A "Developer ID Application" certificate** exported as a `.p12` (the workflow takes
   it base64-encoded in `MAC_CERT_P12`). Team-scoped, not an App Store certificate.
3. **An app-specific password** for the Apple ID (`APPLE_APP_SPECIFIC_PASSWORD`). A
   normal account password does not work with `notarytool`.
4. **The team ID** (`APPLE_TEAM_ID`), the ten-character identifier from the developer
   account page.
5. **A bundle identifier you control** — currently `dev.rosalena.harness`, set from
   `appId` in `electron-builder.mac.yml`.

## What the workflow does

The `macos` job in `.github/workflows/release.yml` has two mutually exclusive steps:

```yaml
- name: Build (unsigned)
  if: env.APPLE_ID == ''
  run: node packaging/release/build.mjs mac

- name: Build (signed)
  if: env.APPLE_ID != ''
  env:
    CSC_LINK: ${{ env.MAC_CERT_P12 }}
    CSC_KEY_PASSWORD: ${{ env.MAC_CERT_PASSWORD }}
  run: node packaging/release/build.mjs mac --sign "$MAC_SIGN_IDENTITY"
```

and a notarization step guarded the same way (`if: env.APPLE_ID != ''`). With no secrets
set the job still builds and uploads the unsigned artifacts — the honest default that
produces something usable, with a documented quarantine workaround.

Notarization itself, if done by hand instead of through electron-builder:

```bash
# after building the .app inside the staging directory
ditto -c -k --keepParent "Rosalena Harness.app" Rosalena-Harness.zip
xcrun notarytool submit Rosalena-Harness.zip \
  --apple-id "$APPLE_ID" \
  --password "$APPLE_APP_SPECIFIC_PASSWORD" \
  --team-id "$APPLE_TEAM_ID" \
  --wait
xcrun stapler staple "Rosalena Harness.app"
xcrun stapler validate "Rosalena Harness.app"
```

`--wait` matters: submitting without it returns an id while the scan is still running, and
a later `stapler staple` then fails with "record not found".

`xcrun notarytool log <submission-id> --apple-id ... --password ... --team-id ...` prints
the reason for any rejection. The usual causes here:

- hardened runtime missing (the config sets it; do not remove it),
- an entitlements key not covered by a notarization exception,
- an embedded binary not signed with the same identity (Electron's helpers — the
  `entitlementsInherit` key is what signs them),
- `CFBundleIdentifier` mismatch between `appId` and the certificate's team.

## Verifying a signed build

```bash
codesign -dv --verbose=4 "/Applications/Rosalena Harness.app"     # Authority, TeamIdentifier
codesign --verify --deep --strict --verbose=2 "/Applications/Rosalena Harness.app"
spctl -a -vvv -t install "/Applications/Rosalena Harness.app"    # should say "accepted, Notarized Developer ID"
xcrun stapler validate "/Applications/Rosalena Harness.app"      # "The validate action worked!"
```

`spctl` saying `rejected (the code is valid but does not seem to be an app)` is a
different problem: a `.dmg` must be checked with `-t open --context context:primary-signature`
or simply opened. Do not paste that as a failed release.

## Expected first-run behavior, honestly

- **Unsigned**: double-clicking from `~/Downloads` shows "Apple could not verify … is free
  of malware" (macOS 14) or "damaged" (older macOS, larger files). Right-click → Open
  works on macOS 14 and earlier; macOS 15 removed the right-click bypass, so the user has
  to run the `xattr` command from `packaging/release/README.md` §4.
- **Signed but not notarized**: `spctl` rejects it; same workaround still applies.
- **Signed and notarized**: opens normally, no prompt.

None of this substitutes for a Mac user testing it. That is still outstanding.
