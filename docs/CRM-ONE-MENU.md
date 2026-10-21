# Optional: collapse the two menus into one

Default is **two menus**, and that is the recommendation:

- `🚀 STPi + DeskOS Command OS` — their file (`Code.gs`)
- `⚡ Tapstall` — `TapstallMasterSheet.gs`

Two menus is not a compromise; it is the only arrangement that survives their upgrades. Their
`Code.gs` is *hosted* (`https://stpi-deskos.stpi-cloud.workers.dev/deskos/master-sheet-code.gs`) and
you re-paste it whenever they ship a change. Anything added to their file is lost on that re-paste.
Anything in its own file stays.

You only need one menu if you prefer it. Add this to **their** `Code.gs`, immediately before the
final `.addToUi();` in `onOpen()`:

```js
    .addSeparator()
    .addSubMenu(SpreadsheetApp.getUi()
      .createMenu("⚡ Tapstall")
      .addItem("Sync Tapstall leads now", "tapstallSyncNow")
      .addItem("Push stage changes to Tapstall", "tapstallPushStages")
      .addItem("Pipeline health", "tapstallStatus")
      .addItem("Turn ON 2-hour sync", "tapstallInstallTriggers")
      .addItem("Turn OFF Tapstall timers", "tapstallRemoveTriggers")
      .addItem("Rebuild Tab 4 myself", "tapstallRebuildQueue"))
```

Then set `TPS_MENU_OWNED=true` in Script Properties so `TapstallMasterSheet.gs` stops registering its
own on-open trigger (otherwise the menu appears twice).

**Cost of doing this:** the next time you paste a fresh `Code.gs` from their worker, the submenu is
gone and you re-apply six lines. That is the whole trade. If you value a single menu more than that,
do it; otherwise leave the two.
