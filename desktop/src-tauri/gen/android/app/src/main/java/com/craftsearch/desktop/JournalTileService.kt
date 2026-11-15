package com.craftsearch.desktop

import android.app.PendingIntent
import android.app.ActivityOptions
import android.content.Intent
import android.os.Build
import android.service.quicksettings.Tile
import android.service.quicksettings.TileService

class JournalTileService : TileService() {
    override fun onStartListening() {
        super.onStartListening()
        qsTile?.apply { state = Tile.STATE_INACTIVE; label = "记一条"; updateTile() }
    }
    override fun onClick() {
        super.onClick()
        val open = Runnable {
            val intent = Intent(this, MainActivity::class.java).apply {
                action = JOURNAL_CAPTURE_ACTION
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
            }
            if (Build.VERSION.SDK_INT >= 34) {
                val options = ActivityOptions.makeBasic()
                if (Build.VERSION.SDK_INT >= 35) {
                    options.setPendingIntentCreatorBackgroundActivityStartMode(ActivityOptions.MODE_BACKGROUND_ACTIVITY_START_ALLOWED)
                }
                startActivityAndCollapse(PendingIntent.getActivity(this, 22054, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE, options.toBundle()))
            } else {
                @Suppress("DEPRECATION")
                startActivityAndCollapse(intent)
            }
        }
        if (isLocked) unlockAndRun(open) else open.run()
    }
    companion object { const val JOURNAL_CAPTURE_ACTION = "com.craftsearch.desktop.QUICK_JOURNAL" }
}
