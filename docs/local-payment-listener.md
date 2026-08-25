# Local USB payment listener

The local listener accepts payment-notification Webhooks from an Android phone connected to the register computer over USB. [SmsForwarder](https://github.com/pppscn/SmsForwarder) and [notify-me](https://github.com/jinweijie/notify-me) can run independently or together; matching dual deliveries are deduplicated. It is deliberately not a general SMS inbox.

## Privacy boundary

- The listener binds only to `127.0.0.1`.
- `adb reverse` carries the phone's loopback request through the USB cable; no public webhook is required.
- The browser can pair only from an allow-listed application origin.
- Raw message text, phone numbers, OTPs, TACs, PINs, passwords and login codes are never returned to the browser or written to MongoDB.
- Authentication or outgoing-payment messages are rejected before parsing.
- MongoDB receives only provider, amount, currency, receiving time, an optional transaction reference, a masked account tail and irreversible fingerprints.
- A local notification is supporting evidence with status `REQUIRES_REVIEW`. It cannot mark a POS sale paid without a provider API, signed provider callback or receiving-side bank verification.

## Start the listener

Install Android platform tools and authorise USB debugging on the dedicated receiving phone. The quickest setup is **Payments → Local payment listener → Download listener**, followed by:

```powershell
node konkon-payment-listener.cjs
```

Developers running from the repository can instead use:

```powershell
npm run bridge:payments
```

The script attempts this mapping at startup and rechecks it while the browser is connected:

```powershell
adb reverse tcp:17321 tcp:17321
```

The terminal prints a browser pairing code, a Webhook secret and two loopback endpoints. Secrets remain in the local terminal and must not be committed.

Production installations should set stable secrets through the local process environment or the computer's ignored `.env.local` file:

```text
LOCAL_PAYMENT_WEBHOOK_SECRET=<at least 16 random characters>
LOCAL_PAYMENT_NOTIFY_ME_TOKEN=<random bearer token>
LOCAL_PAYMENT_ALLOWED_SENDERS=<comma-separated bank or wallet sender IDs>
LOCAL_PAYMENT_BRIDGE_ORIGINS=https://your-approved-pos-domain.example
LOCAL_PAYMENT_ADB_PATH=<optional absolute path to adb.exe when it is not in PATH>
LOCAL_PAYMENT_ADB_SERIAL=<optional Android serial when multiple devices are connected>
```

`LOCAL_PAYMENT_ALLOWED_SENDERS` is strongly recommended. Even with an allow-list, SMS evidence remains review-only because sender IDs can be spoofed and notifications can be delayed.

## SmsForwarder development adapter

Endpoint:

```text
http://127.0.0.1:17321/sms
```

POST form template:

```text
from=[from]&content=[content]&timestamp=[timestamp]&sign=[sign]&receive_time=[receive_time]
```

Configure the same secret printed by the listener so its HMAC signature can be verified. Create narrow sender/content rules for receiving banks and wallets only. Never enable “forward all messages”, call forwarding, contact access, remote message queries or remote SMS sending.

Important licensing boundary: the SmsForwarder repository states that its code/APK is for testing and research and prohibits commercial use. The adapter may be used for development evaluation, but it must not be part of a commercial Kōn-Kōn deployment without written permission or a compatible licence from its owner.

## notify-me adapter

Endpoint:

```text
http://127.0.0.1:17321/notify-me
```

Custom header:

```text
Authorization: Bearer <LOCAL_PAYMENT_NOTIFY_ME_TOKEN>
```

Body template:

```json
{"type":"<TYPE>","sender":"<SENDER>","message":"<MESSAGE>","timestamp":"<TIMESTAMP>"}
```

The notify-me repository documents this default Webhook shape and publishes the project under WTFPL. Configure only SMS events and narrow payment-sender rules. Calls and unrelated messages are discarded by the local listener.

notify-me 1.5.0 appends a trailing slash when it sends the request; the bridge accepts both `/notify-me` and `/notify-me/`. The app may also request phone-state and call-log permissions on launch. Deny those permissions: this adapter needs only `READ_SMS` and `RECEIVE_SMS`, and phone/call forwarding is outside the privacy boundary.

## Browser pairing and MongoDB

Open **Payments → Local payment listener**, enter the six-digit code from the local terminal and pair. The token is kept in `sessionStorage`, never in the application database. The page polls only the local sanitized event queue and submits each structured event through the authenticated `/api/local-payment-events` route.

MongoDB indexes provide event deduplication, review-queue lookup, candidate payment-intent matching and automatic 30-day evidence expiry. Duplicate imports are idempotent.

## Operational safety

Use a dedicated receiving phone rather than a personal device. Remove USB debugging authorisation when the register is retired, rotate both local secrets after staff or device changes, and test with synthetic payment-notification fixtures before using real funds.
