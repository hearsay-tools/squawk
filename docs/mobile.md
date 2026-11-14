# Squawk on your phone

Use your phone's browser. The cockpit has a mobile layout with a tab bar, a
**More** sheet and swipe actions. It shows the same tasks,
conversations, questions and reviews as the desktop browser. Agents keep running
on your server.

Squawk has no native iPhone or Android app. The earlier personal-install apps
were removed: they only showed the same cockpit in a web view.

## Before you start

The phone must reach your Squawk server over HTTPS. When the server is private,
connect the phone to the same VPN first. To host Squawk on a server, see
[Remote access](../README.md#remote-access-host-squawk-on-a-server) and the
[server install guides](server-install/README.md). Your server's remote-mode
restrictions apply to the phone too.

## Open the cockpit

1. Open your cockpit address, for example `https://squawk.example.com`, in the
   phone's browser.
2. Sign in as you do on a computer, including MFA if your server asks for it.

## Add it to the home screen

An icon on the home screen opens the cockpit in one tap.

- **iPhone (Safari):** tap **Share**, then **Add to Home Screen**, then **Add**.
- **Android (Chrome):** tap the **⋮** menu, then **Add to Home screen** or
  **Install app**, then confirm.

The browser keeps your sign-in session, as it does for any other site. When you
come back to the cockpit after you switch apps or lock the phone, it updates its
live stream. If the page looks out of date, reload it. A reload never runs a task
again.

## Limits

- No push notifications.
- No offline cockpit: the phone must reach the server.
- Agents never run on the phone.
