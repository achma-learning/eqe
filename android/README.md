# Banque EQE — Android app

A thin native wrapper around `question-bank.html` (the same offline study app
from the repo root). One `WebView`, no network calls, no separate native UI
to keep in sync — the whole app is the web app in `app/src/main/assets/`.

- **Package:** `online.eqe.questionbank`
- **Min SDK:** 23 (Android 6.0) · **Target SDK:** 34
- **Permissions:** none. The app never touches the network; tapping a "voir
  sur e-qe.online" link hands off to the device's browser instead.
- **Storage:** progress/settings persist via the WebView's local storage,
  scoped to this app — same behavior as the browser version, just backed by
  the app's private data instead of a desktop browser profile.

## Install the prebuilt APK

`dist/banque-eqe-debug.apk` is a debug build, self-signed with Gradle's
default debug key (fine to sideload for personal use; not suitable for Play
Store distribution as-is). On the device: enable "install unknown apps" for
the app you use to open the file, then open the APK.

## Rebuild from source

Whenever `data/*.txt` changes or `question-bank.html` is rebuilt, refresh
the bundled asset before building:

```sh
node tools/build-question-bank.js
cp question-bank.html data.html android/app/src/main/assets/
cd android
./gradlew assembleDebug
```

Output: `app/build/outputs/apk/debug/app-debug.apk`.

Requires a JDK (17+) and the Android SDK (`platform-tools`,
`platforms;android-34`, `build-tools;34.0.0`). Point `local.properties` (not
committed — machine-specific) at your SDK:

```
sdk.dir=/path/to/Android/sdk
```

## Notes

- `MainActivity` exposes the hardware/gesture back button to the web app via
  a small JS hook (`window.__qbAndroidBack`) so it steps up one screen
  (exam → module → dashboard) before exiting, matching the in-app `Esc`
  behavior in the desktop/browser version.
- The launcher icon is a single `VectorDrawable` (`res/drawable/ic_launcher.xml`),
  so it renders correctly on every supported API level without needing a set
  of exported PNG densities.
