# Parallax M1

Small Expo + TypeScript prototype for iPhone-to-iPhone Nearby Interaction. The native module owns MultipeerConnectivity, token exchange, NISession lifecycle, recovery, and structured diagnostics; the TypeScript layer owns presentation and smoothing.

## Development

Use Node 24 on this machine if Homebrew Node 25 reports a missing `libsimdjson` library:

```sh
PATH=/opt/homebrew/opt/node@24/bin:$PATH npm install
npx expo prebuild
npx expo start --dev-client
```

The first native build must happen after the module and config plugin exist:

```sh
eas login
eas build:configure
eas device:create
eas build --profile development --platform ios
```

Register both physical iPhones with `eas device:create` (or the EAS dashboard). No USB cable is required: each phone opens the generated registration URL, installs the device profile, and EAS includes the registered UDID in the ad hoc build. Install the resulting build from its EAS-generated URL. The broken Lightning port is therefore not a blocker.

After the development build is installed, run `npx expo start --dev-client`; TypeScript UI, smoothing, layout, and visualization changes use Fast Refresh. Rebuild only after changing `modules/parallax-module`, `plugins/withParallaxIos`, iOS permissions, entitlements, or other native configuration.

## Device acceptance checklist

This repository does not claim physical-device success yet. On both phones: install the same development build, grant local-network permission, start discovery, select the other phone, start ranging, move the phones and observe raw/smoothed centimetres, then disconnect and reconnect. Record the diagnostic log and any `NISession` invalidation reason.
