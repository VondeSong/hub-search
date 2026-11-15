package com.craftsearch.desktop

import android.graphics.Bitmap
import android.os.ParcelFileDescriptor
import android.os.SystemClock
import android.view.InputDevice
import android.view.KeyCharacterMap
import android.view.KeyEvent
import android.view.accessibility.AccessibilityNodeInfo
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/** Runs in the test package so the client can really die before a tile click. */
@RunWith(AndroidJUnit4::class)
class MobileColdTileTest {
    private val test = InstrumentationRegistry.getInstrumentation()
    private val runId = InstrumentationRegistry.getArguments().getString("acceptanceRunId")!!
    private val report = JSONObject().put("runId", runId).put("checks", JSONArray())
    private val directory by lazy { File(test.context.getExternalFilesDir(null), "mobile-acceptance/$runId/cold").apply { mkdirs() } }
    private fun shell(command: String) = ParcelFileDescriptor.AutoCloseInputStream(test.uiAutomation.executeShellCommand(command)).bufferedReader().use { it.readText() }.trim()
    private fun until(label: String, seconds: Int = 45, predicate: () -> Boolean) {
        val deadline = SystemClock.elapsedRealtime() + seconds * 1000
        while (SystemClock.elapsedRealtime() < deadline) { if (predicate()) return; SystemClock.sleep(120) }
        error("Timed out: $label")
    }
    private fun node(predicate: (AccessibilityNodeInfo) -> Boolean): AccessibilityNodeInfo? {
        fun find(n: AccessibilityNodeInfo?): AccessibilityNodeInfo? {
            if (n == null) return null
            if (predicate(n)) return n
            for (i in 0 until n.childCount) find(n.getChild(i))?.let { return it }
            return null
        }
        return find(test.uiAutomation.rootInActiveWindow)
    }
    private fun screenshot(name: String) {
        test.uiAutomation.takeScreenshot()?.let { bitmap -> File(directory, "$name.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }; bitmap.recycle() }
    }
    private fun result(name: String, passed: Boolean) {
        report.getJSONArray("checks").put(JSONObject().put("name", name).put("passed", passed)); check(passed) { name }
    }
    private fun back() {
        val now = SystemClock.uptimeMillis()
        for (action in listOf(KeyEvent.ACTION_DOWN, KeyEvent.ACTION_UP)) test.uiAutomation.injectInputEvent(KeyEvent(now, SystemClock.uptimeMillis(), action, KeyEvent.KEYCODE_BACK, 0, 0, KeyCharacterMap.VIRTUAL_KEYBOARD, 0, KeyEvent.FLAG_FROM_SYSTEM, InputDevice.SOURCE_KEYBOARD), true)
    }
    private fun composer() = node { it.packageName?.toString() == "com.craftsearch.desktop" && (it.contentDescription?.toString() == "关闭速记" || it.text?.toString() == "关闭速记") } != null

    @Test fun actualProcessColdTileEntry() {
        try {
            check(test.targetContext.packageName == "com.craftsearch.desktop.acceptance")
            shell("cmd statusbar collapse")
            shell("am start -W -n com.craftsearch.desktop/.MainActivity")
            val previous = shell("pidof com.craftsearch.desktop")
            require(previous.matches(Regex("[0-9]+")))
            test.uiAutomation.injectInputEvent(KeyEvent(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_HOME), true)
            test.uiAutomation.injectInputEvent(KeyEvent(KeyEvent.ACTION_UP, KeyEvent.KEYCODE_HOME), true)
            // Simulate process reclaim, preserving the stopped flag and every data file.
            shell("run-as com.craftsearch.desktop kill -9 $previous")
            until("the old client process is gone", 12) { shell("pidof com.craftsearch.desktop") != previous }
            result("cold entry begins after the real client process exited", true)
            shell("cmd statusbar expand-settings")
            var tile: AccessibilityNodeInfo? = null
            for (page in 0..4) {
                until("Quick Settings available", 12) { node { it.packageName?.toString() == "com.android.systemui" } != null }
                tile = node { it.text?.toString() == "记一条" || it.contentDescription?.contains("记一条") == true }
                if (tile != null) break
                val pager = node { it.isScrollable && (it.viewIdResourceName?.contains("pager") == true || it.className?.contains("ViewPager") == true) }
                check(pager?.performAction(AccessibilityNodeInfo.ACTION_SCROLL_FORWARD) == true) { "The Hub tile is not on an accessible Quick Settings page" }
                SystemClock.sleep(180)
            }
            check(tile != null) { "The registered Hub tile is not visible" }
            screenshot("01-system-tile")
            var clickable = tile!!
            while (!clickable.isClickable && clickable.parent != null) clickable = clickable.parent
            check(clickable.performAction(AccessibilityNodeInfo.ACTION_CLICK))
            until("cold tile opens the actual composer", 90) { composer() }
            val current = shell("pidof com.craftsearch.desktop")
            result("the tile starts a new client process", current.matches(Regex("[0-9]+")) && current != previous)
            result("cold tile goes directly to the journal composer", composer())
            until("formatted draft is displayed after real process reclaim") { node { it.packageName?.toString() == "com.craftsearch.desktop" && it.text?.contains("Hub 控制中心草稿验收") == true } != null }
            result("cold tile displays the retained nonempty journal draft", true)
            screenshot("02-cold-composer")
            // The first Back can hide the IME; the next closes only the draft.
            back(); SystemClock.sleep(450)
            if (composer()) back()
            until("cold composer returns without creating a record") { !composer() }
            result("Back leaves the cold composer without implicit save", true)
            report.put("completed", true)
        } catch (failure: Throwable) {
            report.put("failure", failure.toString()); screenshot("failure"); throw failure
        } finally { File(directory, "result.json").writeText(report.toString(2), Charsets.UTF_8) }
    }
}
