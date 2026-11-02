# Closed-testing sign-up: one-time setup

Testers open `https://faidahq.com/beta/?app=<app>`, enter their email, and are added to that app's Google Group. The group is attached to the app's Play closed-testing track, so they get access with no work from you.

## 1. Create the Google Group (Workspace Admin console)

1. Groups -> Create group, e.g. `biasharathrive-testers@faidahq.com`.
2. Open the group's settings and allow **members outside your organization**. Testers use Gmail addresses, so the script can't add them without this.
3. Leave join and post settings restrictive. The script adds people itself.

## 2. Attach the group to Play Console

App -> Testing -> Closed testing -> your track -> Testers -> add the Google Group email. Keep your existing email list. A track can use both.

Copy the track's **opt-in link** (the "How testers join" link). It looks like `https://play.google.com/apps/testing/<package name>`.

## 3. Create the Apps Script

1. Create a new Google Sheet (name it e.g. "Beta sign-ups"). Extensions -> Apps Script.
2. Paste in [Code.gs](Code.gs), replacing everything.
3. Fill in the `APPS` entry: `group`, `optInUrl`, and `playUrl` (replace `REPLACE.PACKAGE.NAME` with your Android package name).
4. Left sidebar, Services -> **+** -> **Admin SDK API** -> Add. Leave the identifier as `AdminDirectory`.
5. Deploy -> New deployment -> type **Web app**:
   - Execute as: **Me** (your Workspace admin account)
   - Who has access: **Anyone**
6. Authorise when asked, then copy the **Web app URL**.

The script must run as a Workspace admin (or a user with the Groups Admin role), because it adds group members.

## 4. Point the page at it

In [../beta/beta.js](../beta/beta.js), replace `PASTE_APPS_SCRIPT_WEB_APP_URL_HERE` with the Web app URL, then push the site.

## 5. Test

1. Open `https://faidahq.com/beta/?app=biasharathrive` and sign up with a spare Gmail.
2. Check the Sheet's `Signups` tab and the group's member list.
3. Open the opt-in link on a phone signed in with that account.

## Adding another app

1. Create its group and attach it to its Play track.
2. Add an entry to `APPS` in the script (key = the `?app=` value).
3. Deploy -> Manage deployments -> edit -> **New version**. The URL stays the same.
4. Put its icon in `/img/` and set `icon`.

## Notes

- Testers count toward Play's requirement only after they open the opt-in link, accept, and install. The page walks them through this.
- Sign-ups are rate-limited to 20 a minute across the script, and a hidden field catches simple bots.
- After code changes in Apps Script, redeploy as a **new version**, or the web app keeps running the old code.
