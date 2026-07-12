# Firebase Push Relay

This deploys the managed Volt push relay contract to Firebase Cloud Functions. It stores raw FCM registration tokens in Firestore, returns target-scoped relay credentials to the mobile app, and lets a paired desktop host notify that target without ever receiving the raw FCM token.

- `POST /v1/push-targets`: called by the mobile app with `{ provider:"fcm", platform:"ios", token, enabled }`; returns `{ pushTargetId, pushTargetAuthToken, relayUrl, tokenHash }`.
- `POST /v1/notifications`: called by the desktop host with `{ pushTargetId, pushTargetAuthToken, eventId, kind, title, body, data }`.
- `POST /v1/live-activities`: called by the desktop host with `{ pushTargetId, pushTargetAuthToken, activityId, activityPushToken, tokenEnvironment?, eventId, kind, contentState, ... }`.

Volt host state stores only the opaque relay target id, the target-scoped relay auth token, and an optional FCM token hash.

## Error responses

FCM send failures return `502 { error: "fcm_send_failed", code }` with the FCM
error code, and the full error is logged to Cloud Logging (`console.error`).

Live Activity updates with `tokenEnvironment: "development"` are rejected with
`422 { error: "live_activity_environment_unsupported" }` before reaching FCM:
FCM delivers `live_activity_token` pushes through the production APNs
environment only, so a sandbox ActivityKit token (any Xcode-installed build —
Debug or Release) can never be reached this way. Hosts treat the 422 as a
permanently invalid channel and stop retrying. Set
`LIVE_ACTIVITY_ALLOW_DEVELOPMENT=1` on the function to attempt delivery anyway.

## Setup

From this directory:

```bash
firebase use volt-3fae7
firebase firestore:databases:create '(default)' --project volt-3fae7 --location nam5
firebase deploy --project volt-3fae7 --only firestore:rules,functions:volt-push-relay:pushRelay
```

Use a different Firestore location if `nam5` is not the intended project location.
Cloud Functions deployment requires the Firebase project to be on the Blaze plan so Firebase can enable the Cloud Build and Artifact Registry APIs.

The official Volt host defaults to the managed relay URL. For a self-hosted relay, point the host at the deployed function URL:

```bash
export VOLT_PUSH_RELAY_URL="https://<pushRelay function URL>/"
volt remote host --mobile --workspace volt=/path/to/Volt
```

For iOS delivery, the Firebase project also needs an iOS app registered with the bundle id used by the client app, the generated `GoogleService-Info.plist` included in the app target, and APNs credentials configured in Firebase Console.
