package com.craftsearch.desktop

import android.app.Activity
import android.content.ClipboardManager
import android.content.Intent
import android.os.ParcelFileDescriptor
import android.graphics.Bitmap
import android.os.SystemClock
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.view.accessibility.AccessibilityNodeInfo
import android.view.inputmethod.EditorInfo
import android.webkit.WebView
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.runner.lifecycle.ActivityLifecycleMonitorRegistry
import androidx.test.runner.lifecycle.Stage
import org.json.JSONArray
import org.json.JSONObject
import org.json.JSONTokener
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/** Opt-in instrumentation against the installed app and current data. It never replaces IPC. */
@RunWith(AndroidJUnit4::class)
class MobilePrototypeAcceptanceTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private lateinit var activity: Activity
    private lateinit var web: WebView
    private val runId = InstrumentationRegistry.getArguments().getString("acceptanceRunId") ?: System.currentTimeMillis().toString()
    private val phase = InstrumentationRegistry.getArguments().getString("acceptancePhase") ?: "journal"
    private val evidence = JSONObject().put("checks", JSONArray()).put("runId", runId)
    private val directory by lazy { File(instrumentation.targetContext.getExternalFilesDir(null), "mobile-acceptance/$runId/$phase").apply { mkdirs() } }
    private fun attachWeb() {
        until("production WebView attached") {
            var found: WebView? = null
            instrumentation.runOnMainSync { found = findWeb(activity.window.decorView) }
            if (found != null) web = found!!
            found != null
        }
        until("application ready", 90) { dom(".mobile-app-shell") }
        until("Hub owns the focused app window") { var focus = false; instrumentation.runOnMainSync { focus = activity.hasWindowFocus() }; focus }
    }
    private fun resumedMain() {
        until("production MainActivity resumed", 50) {
            var found: Activity? = null
            instrumentation.runOnMainSync { found = ActivityLifecycleMonitorRegistry.getInstance().getActivitiesInStage(Stage.RESUMED).firstOrNull { it is MainActivity } }
            if (found != null) activity = found!!
            found != null
        }
        attachWeb()
    }
    private fun launchMain() {
        shell("cmd statusbar collapse")
        shell("am start -W -n com.craftsearch.desktop/.MainActivity")
        resumedMain()
    }
    private fun shell(command: String): String = ParcelFileDescriptor.AutoCloseInputStream(instrumentation.uiAutomation.executeShellCommand(command)).bufferedReader().use { it.readText() }
    private fun systemNode(predicate: (AccessibilityNodeInfo) -> Boolean): AccessibilityNodeInfo? {
        fun find(node: AccessibilityNodeInfo?): AccessibilityNodeInfo? {
            if (node == null) return null
            if (predicate(node)) return node
            for (i in 0 until node.childCount) find(node.getChild(i))?.let { return it }
            return null
        }
        return find(instrumentation.uiAutomation.rootInActiveWindow)
    }
    private fun systemClick(texts: List<String>) {
        var node: AccessibilityNodeInfo? = null
        until("system confirmation button") { node = systemNode { it.text?.toString() in texts && it.isEnabled }; node != null }
        var target = node!!
        while (!target.isClickable && target.parent != null) target = target.parent
        check(target.performAction(AccessibilityNodeInfo.ACTION_CLICK)) { "System confirmation did not accept the action" }
    }
    private fun findWeb(v: View): WebView? {
        if (v is WebView) return v
        if (v is ViewGroup) for (i in 0 until v.childCount) findWeb(v.getChildAt(i))?.let { return it }
        return null
    }
    private fun js(expression: String): Any? {
        val latch = CountDownLatch(1)
        var result: String? = null
        activity.runOnUiThread { web.evaluateJavascript("(()=>{try{return JSON.stringify({ok:true,value:($expression)})}catch(e){return JSON.stringify({ok:false,error:String(e)})}})()") { value -> result = value; latch.countDown() } }
        check(latch.await(12, TimeUnit.SECONDS)) { "WebView did not answer" }
        val value = JSONObject(JSONTokener(result).nextValue() as String)
        check(value.optBoolean("ok")) { value.optString("error") }
        return value.opt("value")
    }
    private fun until(label: String, seconds: Long = 35, predicate: () -> Boolean) {
        val end = SystemClock.elapsedRealtime() + seconds * 1000
        while (SystemClock.elapsedRealtime() < end) { if (predicate()) return; SystemClock.sleep(120) }
        throw AssertionError("Timed out: $label")
    }
    private fun dom(selector: String) = js("!!document.querySelector(${JSONObject.quote(selector)})") == true
    private fun waitDom(selector: String) = until(selector, 90) { js("document.querySelector(${JSONObject.quote(selector)})?.checkVisibility()===true") == true }
    private fun click(selector: String) {
        tapElement("document.querySelector(${JSONObject.quote(selector)})")
    }
    private fun clickText(text: String, selector: String = "button") {
        tapElement("[...document.querySelectorAll(${JSONObject.quote(selector)})].find(e=>e.textContent.trim()===${JSONObject.quote(text)} && e.checkVisibility())")
    }
    private fun clickContaining(text: String, selector: String = "button") {
        tapElement("[...document.querySelectorAll(${JSONObject.quote(selector)})].find(e=>e.textContent.includes(${JSONObject.quote(text)}) && e.checkVisibility())")
    }
    private fun tapElement(expression: String) {
        js("(()=>{const e=($expression);if(!e)throw Error('Missing control: '+${JSONObject.quote(expression)});e.scrollIntoView({block:'center',behavior:'instant'});return true})()")
        var previous = ""; var stable = 0; var rect: JSONObject? = null
        until("stable visible enabled control: $expression") {
            val value = js("(()=>{const e=($expression);if(!e||e.disabled||!e.checkVisibility())return null;const r=e.getBoundingClientRect(),top=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);if(r.width<=0||r.height<=0||!(e===top||e.contains(top)))return null;return{x:r.x+r.width/2,y:r.y+r.height/2,dpr:devicePixelRatio,height:visualViewport?.height||innerHeight}})()") as? JSONObject
            val location = IntArray(2); instrumentation.runOnMainSync { web.getLocationOnScreen(location) }
            val signature = value?.toString() + location.contentToString()
            if (value != null && signature == previous) stable++ else stable = 0
            previous = signature; rect = value; stable >= 2
        }
        tapRect(rect!!)
    }
    private fun tapRect(rect: JSONObject) {
        until("Hub focused before app tap") { var focus = false; instrumentation.runOnMainSync { focus = activity.hasWindowFocus() }; focus }
        val location = IntArray(2)
        instrumentation.runOnMainSync { web.getLocationOnScreen(location) }
        val x = (rect.getDouble("x") * rect.getDouble("dpr") + location[0]).toFloat()
        val y = (rect.getDouble("y") * rect.getDouble("dpr") + location[1]).toFloat()
        val now = SystemClock.uptimeMillis()
        check(instrumentation.uiAutomation.injectInputEvent(MotionEvent.obtain(now, now, MotionEvent.ACTION_DOWN, x, y, 0), true))
        check(instrumentation.uiAutomation.injectInputEvent(MotionEvent.obtain(now, now + 50, MotionEvent.ACTION_UP, x, y, 0), true))
        SystemClock.sleep(100)
    }
    private fun asyncJs(body: String): Any? {
        js("(()=>{window.__hubMobileAcceptance={done:false};(async()=>{$body})().then(value=>window.__hubMobileAcceptance={done:true,value},error=>window.__hubMobileAcceptance={done:true,error:String(error)});return true})()")
        until("native operation", 180) { js("window.__hubMobileAcceptance?.done===true") == true }
        val value = js("window.__hubMobileAcceptance") as JSONObject
        check(!value.has("error")) { value.optString("error") }
        return value.opt("value")
    }
    private fun native(command: String, args: JSONObject = JSONObject()): Any? = asyncJs("return await window.__TAURI_INTERNALS__.invoke(${JSONObject.quote(command)},$args)")
    private fun fill(text: String) {
        until("journal editor is ready for input") { js("document.querySelector('dialog[open] .journal-rich-editor')?.isContentEditable===true") == true }
        js("(()=>{const el=document.querySelector('dialog[open] .journal-rich-editor');el.focus();const range=document.createRange();range.selectNodeContents(el);const s=getSelection();s.removeAllRanges();s.addRange(range);document.execCommand('insertText',false,${JSONObject.quote(text)});el.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText'}));return true})()")
    }
    private fun tapEditor() {
        until("journal editor is ready for a touch") { js("document.querySelector('dialog[open] .journal-rich-editor')?.isContentEditable===true") == true }
        val rect = js("(()=>{const r=document.querySelector('dialog[open] .journal-rich-editor').getBoundingClientRect();return{x:r.x+20,y:r.y+20,dpr:devicePixelRatio}})()") as JSONObject
        tapRect(rect)
    }
    private fun keyboard(): Boolean {
        var visible = false
        instrumentation.runOnMainSync { visible = ViewCompat.getRootWindowInsets(web)?.isVisible(WindowInsetsCompat.Type.ime()) == true }
        return visible
    }
    private fun back() {
        val before = js("({state:history.state,length:history.length,dialogs:[...document.querySelectorAll('dialog[open]')].map(d=>d.getAttribute('aria-label'))})")
        check(instrumentation.uiAutomation.performGlobalAction(android.accessibilityservice.AccessibilityService.GLOBAL_ACTION_BACK))
        SystemClock.sleep(350)
        evidence.put("lastBack", JSONObject().put("before", before).put("after", js("({state:history.state,length:history.length,dialogs:[...document.querySelectorAll('dialog[open]')].map(d=>d.getAttribute('aria-label'))})")))
        File(directory, "progress.json").writeText(evidence.toString(2), Charsets.UTF_8)
    }
    private fun hideKeyboard() { if (keyboard()) { back(); until("native keyboard is hidden") { !keyboard() } } }
    private fun checkResult(name: String, value: Boolean) {
        evidence.getJSONArray("checks").put(JSONObject().put("name", name).put("passed", value))
        File(directory, "progress.json").writeText(evidence.toString(2), Charsets.UTF_8)
        android.util.Log.i("HubMobileAcceptance", "$name: $value")
        assertTrue(name, value)
    }
    private fun screenshot(name: String) {
        val drawn = CountDownLatch(1)
        instrumentation.runOnMainSync {
            if (!activity.hasWindowFocus()) drawn.countDown()
            else web.postVisualStateCallback(SystemClock.uptimeMillis(), object : WebView.VisualStateCallback() {
                override fun onComplete(requestId: Long) { web.postOnAnimation { web.postOnAnimation { drawn.countDown() } } }
            })
        }
        check(drawn.await(12, TimeUnit.SECONDS)) { "WebView did not draw the checked state" }
        instrumentation.waitForIdleSync()
        instrumentation.uiAutomation.waitForIdle(250, 8000)
        instrumentation.uiAutomation.takeScreenshot()?.let { image -> File(directory, "$name.png").outputStream().use { image.compress(Bitmap.CompressFormat.PNG, 100, it) }; image.recycle() }
    }
    private fun list() = (native("list_quick_journal") as JSONObject).getJSONArray("items")
    private fun own(id: String): JSONObject? { val all = list(); for (i in 0 until all.length()) if (all.getJSONObject(i).getJSONObject("record").getString("id") == id) return all.getJSONObject(i); return null }

    @Test
    fun journalAndPrototypeRoundTrip() {
        shell("cmd statusbar collapse")
        launchMain()
        var originalDraft: String? = null
        var captureId = ""
        val marker = "Hub 界面验收 ${System.currentTimeMillis()}"
        try {
            until("application ready", 90) { dom(".mobile-app-shell") }
            originalDraft = native("get_quick_journal_draft") as String
            File(directory, "draft-recovery.json").writeText(originalDraft, Charsets.UTF_8)
            if (originalDraft.isNotBlank()) {
                val original = JSONObject(originalDraft)
                val previous = own(original.optString("id"))
                if (previous?.getJSONObject("record")?.optString("text")?.startsWith("Hub 界面验收 ") == true) {
                    original.put("id", java.util.UUID.randomUUID().toString().replace("-", ""))
                    originalDraft = original.toString()
                    evidence.put("recoveredPriorTestDraftIdentity", true)
                }
            }
            native("save_quick_journal_draft", JSONObject().put("draft", ""))
            val baseline = list().length()
            // The normal product entry is shared by App, quick settings and the composer.
            js("(()=>{window.dispatchEvent(new Event('hub:open-quick-journal'));return true})()")
            waitDom("dialog[aria-label='速记'][open] .journal-rich-editor")
            tapEditor(); until("real keyboard visible") { keyboard() }
            fill("$marker\n\n**保留格式**\n- 第一项\n  - 子项\n#Hub验收")
            instrumentation.runOnMainSync {
                web.onCreateInputConnection(EditorInfo())?.let { connection ->
                    connection.setComposingText(" 中文输入", 1); connection.finishComposingText()
                }
            }
            checkResult("Android composing text reaches the retained draft", js("document.querySelector('dialog[open] .journal-rich-editor').textContent.includes('中文输入')") == true)
            val capture = js("(()=>{const r=document.querySelector('dialog[open] [aria-label=保存记录]').getBoundingClientRect();return{bottom:r.bottom,height:innerHeight,viewport:visualViewport.height}})()") as JSONObject
            checkResult("keyboard leaves save reachable", capture.getDouble("bottom") <= capture.getDouble("height") + 2)
            screenshot("01-composer-keyboard")
            back(); checkResult("first Back hides IME and keeps draft open", !keyboard() && dom("dialog[aria-label='速记'][open]"))
            back(); until("new composer dismissed") { !dom("dialog[aria-label='速记'][open]") }
            checkResult("closing a new note only keeps a draft", list().length() == baseline)
            js("(()=>{window.dispatchEvent(new Event('hub:open-quick-journal'));return true})()")
            waitDom("dialog[aria-label='速记'][open] .journal-rich-editor")
            until("draft restored") { js("document.querySelector('dialog[open] .journal-rich-editor').textContent.includes(${JSONObject.quote(marker)})") == true }
            checkResult("rich lists preserve bullets and block rows", js("(()=>{const e=document.querySelector('dialog[open] .journal-rich-editor'),li=e.querySelector('li');return !!li&&getComputedStyle(li).display==='list-item'&&getComputedStyle(li.parentElement).listStyleType!=='none'})()") == true)
            val draftBeforePicker = native("get_quick_journal_draft") as String
            until("restored composer keyboard is visible") { keyboard() }
            click("dialog[open] [aria-label='添加照片']")
            until("Android system photo picker", 60) { systemNode { val name=it.packageName?.toString()?:"";name.contains("documentsui")||name.contains("providers.media")||name.contains("photopicker") } != null }
            screenshot("02-system-photo-picker"); back(); waitDom("dialog[aria-label='速记'][open] .journal-rich-editor")
            checkResult("cancelling the system photo picker preserves the draft", native("get_quick_journal_draft") == draftBeforePicker)
            val image = Bitmap.createBitmap(64, 48, Bitmap.Config.ARGB_8888).apply { eraseColor(android.graphics.Color.rgb(50, 110, 200)) }
            val encoded = java.io.ByteArrayOutputStream().use { out -> image.compress(Bitmap.CompressFormat.PNG, 100, out); android.util.Base64.encodeToString(out.toByteArray(), android.util.Base64.NO_WRAP) }; image.recycle()
            js("(()=>{const dt=new DataTransfer();dt.items.add(new File([Uint8Array.from(atob(${JSONObject.quote(encoded)}),c=>c.charCodeAt(0))],'Hub验收图片.png',{type:'image/png'}));const input=document.querySelector('dialog[open] input[type=file][accept=\"image/*\"]');input.files=dt.files;input.dispatchEvent(new Event('change',{bubbles:true}));return true})()")
            until("native attachment and thumbnail retained") { js("!!document.querySelector('dialog[open] .quick-journal-draft-files img')&& !document.querySelector('dialog[open] [aria-label=保存记录]').disabled") == true }
            checkResult("photo input stores an actual native attachment", (JSONObject(native("get_quick_journal_draft") as String).getJSONArray("attachments").length()) == 1)
            click("dialog[aria-label='速记'] [aria-label='保存记录']")
            waitDom(".mobile-journal-feed")
            until("one capture committed") { val all = list(); (0 until all.length()).any { index -> val item = all.getJSONObject(index); if (item.getJSONObject("record").getString("text").contains(marker)) { captureId = item.getJSONObject("record").getString("id"); true } else false } }
            checkResult("native capture creates exactly one record", list().length() == baseline + 1)
            evidence.put("recordId", captureId)
            waitDom("[data-record-id='$captureId']")
            screenshot("02-journal-feed")
            checkResult("journal create stays inside the viewport", js("(()=>{const b=document.querySelector('.mobile-journal-create button'),r=b.getBoundingClientRect(),e=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return r.top>=0&&r.bottom<=innerHeight+1&&(e===b||b.contains(e))})()") == true)
            click("[data-record-id='$captureId'] [aria-label='编辑这条记录']")
            waitDom("dialog[aria-label='编辑日志'][open]")
            fill("$marker\n\n**修改后**\n- 第一项\n  - 子项\n#Hub验收")
            waitDom("[aria-label='保存修改并返回']")
            screenshot("03-existing-editor")
            if (keyboard()) back()
            back()
            until("edited record saved on Back") { !dom("dialog[aria-label='编辑日志'][open]") && own(captureId)?.getJSONObject("record")?.getString("text")?.contains("修改后") == true }
            checkResult("editing retains ID and record count", list().length() == baseline + 1)
            click("[data-record-id='$captureId'] .mobile-journal-photos button"); waitDom(".mobile-journal-photo-view img")
            checkResult("saved photo opens a real native thumbnail", js("document.querySelector('.mobile-journal-photo-view img').naturalWidth===64") == true)
            back(); until("photo view closes first") { !dom("dialog[open]") }
            click("[data-record-id='$captureId'] button[aria-label^='记录操作']")
            waitDom("dialog.journal-menu-dialog[open]")
            checkResult("twelve record menu actions remain reachable", (js("document.querySelectorAll('.mobile-journal-primary button,.journal-menu-dialog .mobile-journal-menu-list button').length") as Number).toInt() == 12)
            screenshot("04-record-menu")
            clickText("历史版本", "dialog button")
            until("history loaded") { js("document.querySelector('dialog[open]')?.textContent.includes('版本 0')") == true }
            clickContaining("版本 0", "dialog button")
            clickText("恢复此版本", "dialog button")
            until("version restored") { !dom("dialog[open]") && own(captureId)?.getJSONObject("record")?.getString("text")?.contains("保留格式") == true }
            checkResult("history restoration preserves record identity", list().length() == baseline + 1)
            click("[data-record-id='$captureId'] button[aria-label^='记录操作']")
            clickText("设定日期", "dialog button")
            waitDom("dialog input[type=date]")
            js("(()=>{document.querySelector('dialog input[type=date]').value='2026-11-14';return true})()")
            clickText("保存日期", "dialog button")
            until("record date changed") { own(captureId)?.getJSONObject("record")?.getString("date") == "2026-11-14" }
            checkResult("changing date retains original ID", list().length() == baseline + 1)
            click("[data-record-id='$captureId'] button[aria-label^='记录操作']")
            clickText("删除", "dialog button"); clickText("移到回收站", "dialog button")
            until("record in trash") { own(captureId)?.optBoolean("deleted") == true && !dom("dialog[open]") }
            click("[aria-label='日志导航']"); clickText("回收站", "dialog button")
            until("trash view") { !dom("dialog[open]") && dom("[data-record-id='$captureId']") }
            clickText("恢复记录")
            until("record restored from trash") { own(captureId)?.optBoolean("deleted") == false }
            checkResult("trash restores the same record", list().length() == baseline + 1)
            click("[aria-label='日志导航']"); clickText("日志", "dialog button")
            until("all records view") { !dom("dialog[open]") && dom("[data-record-id='$captureId']") }
            click("[aria-label='速记同步状态']"); waitDom(".mobile-journal-sync")
            checkResult("journal sync has a local retry entrance", js("document.querySelector('.mobile-journal-sync').textContent.includes('同步 / 重试')") == true)
            clickText("同步 / 重试", "dialog button")
            until("manual sync finished", 150) { js("!document.querySelector('.mobile-journal-sync button')?.disabled") == true }
            screenshot("05-inline-sync")
            click("dialog [aria-label='关闭']"); until("sync sheet closed") { !dom("dialog[open]") }

            fun recordMenu() { until("previous journal sheet closed") { !dom("dialog[open]") }; click("[data-record-id='$captureId'] button[aria-label^='记录操作']"); waitDom("dialog.journal-menu-dialog[open]") }
            recordMenu(); clickText("置顶", "dialog button"); until("record pinned") { !dom("dialog[open]") && js("document.querySelector('[data-record-id=\"$captureId\"] header').textContent.includes('置顶')") == true }
            recordMenu(); clickText("取消置顶", "dialog button"); until("record unpinned") { !dom("dialog[open]") }
            checkResult("pin and unpin keep the same journal record", own(captureId) != null)
            recordMenu(); clickText("加入浮窗", "dialog button"); waitDom(".mobile-journal-floating")
            checkResult("floating preview remains inside Hub", dom(".mobile-journal-floating button"))
            click(".mobile-journal-floating button:last-child")
            recordMenu(); clickText("查看详情", "dialog button"); waitDom("dialog[aria-label='记录详情']")
            checkResult("details show the full saved body", js("document.querySelector('dialog[open]').textContent.includes(${JSONObject.quote(marker)})") == true)
            back(); until("details closed") { !dom("dialog[open]") }
            recordMenu(); clickText("相关笔记", "dialog button"); waitDom("dialog[aria-label='相关笔记']"); back(); until("related closed") { !dom("dialog[open]") }
            recordMenu(); clickText("批注", "dialog button"); waitDom("dialog textarea")
            js("(()=>{const e=document.querySelector('dialog textarea'),s=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set;s.call(e,'本轮界面验收批注');e.dispatchEvent(new Event('input',{bubbles:true}));return true})()")
            clickText("保存批注", "dialog button"); until("annotation displayed") { js("document.querySelector('dialog[open]')?.textContent.includes('本轮界面验收批注')") == true }
            checkResult("annotation is kept separately from source text", own(captureId)?.getJSONObject("record")?.getString("text")?.contains("本轮界面验收批注") == false)
            back(); until("annotation details closed") { !dom("dialog[open]") }
            val clipboard = instrumentation.targetContext.getSystemService(ClipboardManager::class.java)
            val previousClip = clipboard.primaryClip
            try {
                recordMenu(); clickText("复制", "dialog button"); until("copied body") { clipboard.primaryClip?.getItemAt(0)?.coerceToText(instrumentation.targetContext)?.contains(marker) == true }
                back(); until("copy menu closed") { !dom("dialog[open]") }
                recordMenu(); clickText("复制链接", "dialog button"); until("copied link") { clipboard.primaryClip?.getItemAt(0)?.coerceToText(instrumentation.targetContext)?.toString() == "hub://journal/$captureId" }
                back(); until("link menu closed") { !dom("dialog[open]") }
                checkResult("copy and record link use the full real record", true)
            } finally { if (previousClip != null) clipboard.setPrimaryClip(previousClip) else clipboard.clearPrimaryClip() }
            recordMenu(); clickText("分享", "dialog button")
            until("Android share chooser") { systemNode { it.packageName?.toString() in setOf("android", "com.android.intentresolver", "com.android.systemui") && (it.text?.contains("分享") == true || it.text?.contains("Shar") == true || it.viewIdResourceName?.contains("chooser") == true) } != null }
            screenshot("07-system-share"); back(); until("share cancelled") { systemNode { it.packageName?.toString() == "com.craftsearch.desktop" } != null }
            if (dom("dialog[open]")) back(); until("share menu closed") { !dom("dialog[open]") }
            checkResult("cancelling system share never creates another journal", list().length() == baseline + 1)
            instrumentation.runOnMainSync { activity.startActivity(Intent(Intent.ACTION_VIEW, android.net.Uri.parse("hub://journal/$captureId")).setPackage(activity.packageName)) }
            waitDom("dialog[aria-label='编辑日志'][open]")
            checkResult("record link opens the same saved record", js("document.querySelector('dialog[open] .journal-rich-editor').textContent.includes(${JSONObject.quote(marker)})") == true)
            until("linked editor keyboard is visible") { keyboard() && js("document.querySelector('dialog[open] .journal-rich-editor')?.isContentEditable===true") == true }
            hideKeyboard(); back(); until("linked editor closed") { !dom("dialog[open]") }

            click("[aria-label='日志导航']"); clickText("返回 Hub 浏览", "dialog button")
            waitDom(".mobile-browse-screen")
            clickContaining("阅读", ".mobile-browse-group button")
            waitDom(".mobile-reading-controls")
            checkResult("reading keeps one filter entrance", (js("document.querySelectorAll('.mobile-reading-status [aria-label^=阅读筛选]').length") as Number).toInt() == 1)
            click(".mobile-reading-status button:last-child")
            waitDom("dialog[aria-label='阅读筛选']")
            val sourceBefore = js("document.querySelector('dialog [aria-label=阅读来源]').value") as String
            js("(()=>{const el=document.querySelector('dialog [aria-label=阅读来源]');el.value=el.value==='dida'?'telegram':'dida';el.dispatchEvent(new Event('change',{bubbles:true}));return true})()")
            clickText("取消", "dialog button"); until("filter cancelled") { !dom("dialog[open]") }
            click(".mobile-reading-status button:last-child"); waitDom("dialog[aria-label='阅读筛选']")
            checkResult("cancelled reading filter never changes the applied source", js("document.querySelector('dialog [aria-label=阅读来源]').value") == sourceBefore)
            clickText("取消", "dialog button"); until("reading filter closed") { !dom("dialog[open]") }
            screenshot("06-reading")
            checkResult("mobile content has no horizontal overflow", js("document.documentElement.scrollWidth<=document.documentElement.clientWidth+1") == true)
            evidence.put("syncConfiguration", native("get_quick_journal_settings") as JSONObject)
            evidence.put("completed", true)
        } catch (failure: Throwable) {
            evidence.put("failure", failure.toString()); screenshot("failure")
            throw failure
        } finally {
            try {
                if (originalDraft != null) native("save_quick_journal_draft", JSONObject().put("draft", originalDraft))
                if (captureId.isNotEmpty() && evidence.optBoolean("completed")) {
                    own(captureId)?.let { item ->
                        native("update_quick_journal", JSONObject().put("id", captureId).put("expectedRevision", item.getString("revision")).put("record", item.getJSONObject("record")).put("deleted", true))
                        evidence.put("testRecordMovedToTrash", true)
                    }
                }
                if (captureId.isNotEmpty()) evidence.put("finalRecord", own(captureId)?.let { JSONObject().put("id", captureId).put("uploaded", it.optBoolean("uploaded")).put("applied", it.optBoolean("applied")).put("revision", it.optString("revision")) })
            } finally { File(directory, "result.json").writeText(evidence.toString(2), Charsets.UTF_8) }
        }
    }

    private val tileComponent = "com.craftsearch.desktop/.JournalTileService"
    private fun requestTile() {
        js("(()=>{window.__tileCheck={done:false};window.__TAURI_INTERNALS__.invoke('add_quick_journal_tile').then(value=>window.__tileCheck={done:true,value},error=>window.__tileCheck={done:true,error:String(error)});return true})()")
    }
    private fun tileResult(): String {
        until("native tile response") { js("window.__tileCheck?.done") == true }
        val response = js("window.__tileCheck") as JSONObject
        evidence.put("lastTileResponse", response)
        check(!response.has("error")) { response.optString("error") }
        return response.getJSONObject("value").getString("status")
    }
    private fun hash(text: String) = java.security.MessageDigest.getInstance("SHA-256").digest(text.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }

    @Test
    fun nativeTileRequestsAndWarmEntry() {
        shell("cmd statusbar collapse")
        launchMain()
        val originalActivity = activity
        val originalDraft = native("get_quick_journal_draft") as String
        File(directory, "draft-recovery.json").writeText(originalDraft, Charsets.UTF_8)
        val before = list()
        val ids = (0 until before.length()).map { before.getJSONObject(it).getJSONObject("record").getString("id") }.toSet()
        try {
            shell("cmd statusbar remove-tile $tileComponent")
            until("previous tile removed") { !shell("settings get secure sysui_qs_tiles").contains("com.craftsearch.desktop") }
            if (systemNode { it.text?.contains("wants to add") == true } != null) { back(); SystemClock.sleep(250) }
            if (!dom(".mobile-journal-feed")) {
                click("nav[aria-label='主要导航'] button[aria-label='浏览']"); waitDom(".mobile-browse-screen")
                clickContaining("日志", ".mobile-browse-group button"); waitDom(".mobile-journal-feed")
            }
            click("[aria-label='日志导航']"); clickText("添加「记一条」到控制中心", "dialog button")
            until("system tile prompt") { systemNode { it.text?.toString() == "记一条" } != null }
            screenshot("01-tile-system-request")
            systemClick(listOf("Don't add", "Don’t add", "Do not add tile", "Cancel", "取消", "不添加"))
            until("cancel status returned to the journal") { js("document.querySelector('.mobile-journal-notice')?.textContent.includes('未添加')") == true }
            back(); until("journal navigation closes") { !dom("dialog[open]") }
            checkResult("cancelling the journal tile request reports no addition", js("document.querySelector('.mobile-journal-notice')?.checkVisibility()") == true)
            checkResult("tile cancellation preserves the capture draft", native("get_quick_journal_draft") == originalDraft)
            requestTile(); until("second system tile prompt") { systemNode { it.text?.toString() == "记一条" } != null }
            systemClick(listOf("Add tile", "Add", "添加", "添加图块"))
            checkResult("system confirms the tile was added", tileResult().contains("已添加"))
            requestTile(); checkResult("adding the same tile is idempotent", tileResult().contains("已包含"))
            js("(()=>{window.__tileFocusLog=[];for(const type of ['focusin','focusout','hub:journal-capture-focus'])window.addEventListener(type,()=>window.__tileFocusLog.push({type,tag:document.activeElement?.tagName,cls:document.activeElement?.className,time:performance.now()}),true);return true})()")
            shell("cmd statusbar expand-settings"); shell("cmd statusbar click-tile $tileComponent")
            resumedMain()
            waitDom("dialog[aria-label='速记'][open] .journal-rich-editor")
            until("app visible after tile") { instrumentation.uiAutomation.rootInActiveWindow?.packageName?.toString() == "com.craftsearch.desktop" }
            screenshot("02-tile-warm-entry")
            shell("cmd statusbar expand-settings"); shell("cmd statusbar click-tile $tileComponent")
            resumedMain()
            until("app visible after repeated tile") { instrumentation.uiAutomation.rootInActiveWindow?.packageName?.toString() == "com.craftsearch.desktop" }
            checkResult("repeated tile clicks keep one composer", (js("document.querySelectorAll('dialog[aria-label=速记][open]').length") as Number).toInt() == 1)
            checkResult("warm tile reuses the existing MainActivity", activity === originalActivity)
            until("tile focuses the journal editor with the native soft keyboard") {
                val active = js("({tag:document.activeElement?.tagName,cls:document.activeElement?.className,editor:document.activeElement?.matches('.journal-rich-editor')})") as JSONObject
                evidence.put("tileFocus", active)
                evidence.put("tileFocusLog", js("window.__tileFocusLog"))
                keyboard() && active.optBoolean("editor")
            }
            checkResult("tile focuses the real journal input and keyboard", js("document.activeElement?.matches('.journal-rich-editor')") == true)
            check(instrumentation.uiAutomation.performGlobalAction(android.accessibilityservice.AccessibilityService.GLOBAL_ACTION_HOME))
            until("Hub moved to the background") { instrumentation.uiAutomation.rootInActiveWindow?.packageName?.toString() != "com.craftsearch.desktop" }
            shell("cmd statusbar expand-settings"); shell("cmd statusbar click-tile $tileComponent")
            resumedMain()
            until("background tile returns to the active editor") { instrumentation.uiAutomation.rootInActiveWindow?.packageName?.toString() == "com.craftsearch.desktop" && keyboard() && js("document.activeElement?.matches('.journal-rich-editor')") == true }
            checkResult("background tile reuses the same activity and single composer", activity === originalActivity && (js("document.querySelectorAll('dialog[aria-label=速记][open]').length") as Number).toInt() == 1)
            if (keyboard()) { back(); until("tile keyboard dismissed") { !keyboard() } }
            back(); until("warm tile draft dismissed") { !dom("dialog[aria-label='速记'][open]") }
            val after = list()
            checkResult("tile entry never saves a journal implicitly", (0 until after.length()).map { after.getJSONObject(it).getJSONObject("record").getString("id") }.toSet() == ids)
            evidence.put("draftSha256", hash(native("get_quick_journal_draft") as String))
            evidence.put("completed", true)
        } catch (failure: Throwable) { evidence.put("failure", failure.toString()); screenshot("failure"); throw failure }
        finally {
            native("save_quick_journal_draft", JSONObject().put("draft", originalDraft))
            File(directory, "result.json").writeText(evidence.toString(2), Charsets.UTF_8)
            // The instrumentation runner owns process cleanup; Tauri retains its background loop.
        }
    }

    @Test
    fun prepareRichColdDraft() {
        try {
            launchMain()
            val original = native("get_quick_journal_draft") as String
            File(directory, "draft-recovery.json").writeText(original, Charsets.UTF_8)
            val count = list().length()
            val image = Bitmap.createBitmap(32, 24, Bitmap.Config.ARGB_8888).apply { eraseColor(android.graphics.Color.rgb(50, 110, 200)) }
            val png = java.io.ByteArrayOutputStream().use { out -> image.compress(Bitmap.CompressFormat.PNG, 100, out); android.util.Base64.encodeToString(out.toByteArray(), android.util.Base64.NO_WRAP) }; image.recycle()
            val attachments = JSONArray().put(native("stage_quick_journal_attachment", JSONObject().put("name", "Hub快捷入口验收.png").put("content", png)))
                .put(native("stage_quick_journal_attachment", JSONObject().put("name", "Hub快捷入口验收.txt").put("content", android.util.Base64.encodeToString("cold draft attachment".toByteArray(), android.util.Base64.NO_WRAP))))
            val fixture = JSONObject().put("version", 1).put("id", java.util.UUID.randomUUID().toString().replace("-", ""))
                .put("date", java.time.LocalDate.now().toString()).put("text", "Hub 控制中心草稿验收\n\n**保留格式**\n- 第一项\n  - 子项\n#Hub验收").put("attachments", attachments).toString()
            File(directory, "fixture.sha256").writeText(hash(fixture))
            native("save_quick_journal_draft", JSONObject().put("draft", fixture))
            checkResult("cold fixture has formatted text, a photo and a file", attachments.length() == 2)
            checkResult("rich cold fixture is persisted by the production command", native("get_quick_journal_draft") == fixture)
            checkResult("preparing a cold draft never creates a journal record", list().length() == count)
            evidence.put("draftSha256", hash(fixture)).put("completed", true)
        } catch (failure: Throwable) { evidence.put("failure", failure.toString()); throw failure }
        finally { File(directory, "result.json").writeText(evidence.toString(2), Charsets.UTF_8) }
    }

    @Test
    fun restoreRichColdDraft() {
        try {
            launchMain()
            val prepared = File(instrumentation.targetContext.getExternalFilesDir(null), "mobile-acceptance/$runId/draft")
            val original = File(prepared, "draft-recovery.json")
            val fingerprint = File(prepared, "fixture.sha256")
            if (original.exists()) {
                val current = native("get_quick_journal_draft") as String
                check(current == original.readText(Charsets.UTF_8) || fingerprint.exists() && hash(current) == fingerprint.readText()) { "Draft changed after preparation; preserved the newer content and recovery file" }
                native("save_quick_journal_draft", JSONObject().put("draft", original.readText(Charsets.UTF_8)))
                checkResult("the original native draft is restored exactly", native("get_quick_journal_draft") == original.readText(Charsets.UTF_8))
            }
            evidence.put("completed", true)
        } catch (failure: Throwable) { evidence.put("failure", failure.toString()); throw failure }
        finally { File(directory, "result.json").writeText(evidence.toString(2), Charsets.UTF_8) }
    }

    @Test
    fun nativeDraftAfterColdRestart() {
        try {
            launchMain()
            val draft = native("get_quick_journal_draft") as String
            val expected = InstrumentationRegistry.getArguments().getString("expectedDraftSha256")
            checkResult("cold tile entry restores the same native draft", expected != null && expected == hash(draft))
            checkResult("consumed cold action never reopens on another start", !dom("dialog[aria-label='速记'][open]"))
            val origin = (js("performance.timeOrigin") as Number).toDouble()
            instrumentation.runOnMainSync { web.reload() }
            until("WebView reload completes", 90) { (js("performance.timeOrigin") as Number).toDouble() > origin && dom(".mobile-app-shell") && !dom("dialog[aria-label='速记'][open]") }
            checkResult("a consumed tile action never reopens on refresh", !dom("dialog[aria-label='速记'][open]"))
            checkResult("native draft survives full WebView reload", native("get_quick_journal_draft") == draft)
            screenshot("01-after-cold-reload")
            evidence.put("completed", true)
        } catch (failure: Throwable) { evidence.put("failure", failure.toString()); if (::web.isInitialized) screenshot("failure"); throw failure }
        finally { File(directory, "result.json").writeText(evidence.toString(2), Charsets.UTF_8) }
    }

    private fun field(selector: String, value: String) {
        js("(()=>{const e=document.querySelector(${JSONObject.quote(selector)});if(!e)throw Error('Missing field');const p=e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(p,'value').set.call(e,${JSONObject.quote(value)});e.dispatchEvent(new Event('input',{bubbles:true}));return true})()")
    }

    @Test
    fun searchReviewEditorAndAppearance() {
        shell("cmd statusbar collapse")
        launchMain()
        val saved = (native("load_user_profile") as JSONObject).getJSONObject("values")
        val cleanupDeck = InstrumentationRegistry.getArguments().getString("cleanupEditorDraftDeckId") ?: "none"
        if (cleanupDeck != "none" && saved.has("hub.flashcards.editor-draft-v1")) {
            val ownDraft = JSONObject(saved.getString("hub.flashcards.editor-draft-v1"))
            check(ownDraft.getJSONObject("target").getString("deckId") == cleanupDeck && ownDraft.getJSONObject("values").getString("question") == "Hub 界面验收未保存闪卡") { "Refusing to remove an unrecognized card draft" }
            asyncJs("const {userProfileStorage:s,flushUserProfileStorage:flush}=await import(new URL('/src/UserProfileStorage.ts',location.href).href);s.removeItem('hub.flashcards.editor-draft-v1');await flush();return true")
            saved.remove("hub.flashcards.editor-draft-v1")
            evidence.put("previousOwnedEditorDraftRecovered", cleanupDeck)
        }
        val before = JSONObject()
        saved.keys().forEach { key -> if (key.startsWith("hub.flashcards.") || key == "hub.mobile.appearance.v1") before.put(key, saved.get(key)) }
        File(directory, "profile-recovery.json").writeText(before.toString(), Charsets.UTF_8)
        val display = shell("wm size")
        val override = Regex("Override size: (\\d+x\\d+)").find(display)?.groupValues?.get(1)
        var searchValue: String? = null
        var ownedDeck = ""
        try {
            if ((native("list_flashcard_decks") as JSONArray).length() == 0) {
                ownedDeck = native("create_flashcard_deck", JSONObject().put("name", "Hub 本轮界面验收 $runId")) as String
                val draft = native("create_flashcard_draft", JSONObject().put("question", "Hub 界面验收：评分按钮应放在哪里？").put("answer", "放在便于点击的底部。").put("explanation", "本轮模拟器验收记录；不作为学习资料。").put("cardType", "qa").put("cardData", JSONObject()).put("media", JSONArray()).put("sourceTitle", "本轮界面验收").put("sourcePath", JSONObject.NULL).put("tags", JSONArray().put("Hub验收")).put("customFields", JSONObject())) as JSONObject
                val accepted = native("resolve_flashcard_drafts", JSONObject().put("draftIds", JSONArray().put(draft.getString("id"))).put("accept", true).put("targetDeckId", ownedDeck)) as JSONObject
                check(accepted.getInt("accepted") == 1)
                evidence.put("ownedTemporaryDeck", ownedDeck)
            }
            click("nav[aria-label='主要导航'] button[aria-label='搜索']"); waitDom(".mobile-search-compact-filters")
            searchValue = js("document.querySelector('.search-box input').value") as String
            field(".search-box input", "Hub")
            val query = js("document.querySelector('.search-box input').value")
            click("select[aria-label='内容类型']"); screenshot("01-native-type-picker"); back()
            checkResult("native type picker Back retains the search", js("document.querySelector('.search-box input').value") == query)
            click("[aria-label='更多搜索筛选']"); waitDom(".mobile-search-filter-form")
            back(); until("search filter closes before route") { !dom(".mobile-search-filter-form") }
            checkResult("filter Back preserves the underlying query", js("document.querySelector('.search-box input').value") == query)
            screenshot("02-search")
            click("nav[aria-label='主要导航'] button[aria-label^='复习']")
            waitDom(".flashcards-workspace")
            until("flashcards loaded", 90) { !dom(".flashcards-loading") && dom(".mobile-flashcard-primary") }
            until("review plan ready", 90) { dom(".mobile-flashcard-today .mobile-flashcard-primary:not(:disabled)") }
            checkResult("review header reflects the current page", js("document.querySelector('.mobile-hub-page-title').textContent") == "复习")
            val label = js("document.querySelector('.mobile-flashcard-today .mobile-flashcard-primary').textContent") as String
            if (label.contains("开始复习") || label.contains("继续复习")) {
                click(".mobile-flashcard-today .mobile-flashcard-primary"); waitDom(".flashcards-workspace.is-reviewing .flashcards-reveal")
                checkResult("review reveal sits in the visible lower area", js("(()=>{const r=document.querySelector('.flashcards-reveal').getBoundingClientRect();return r.top>=innerHeight*.45&&r.bottom<=innerHeight+2})()") == true)
                click(".flashcards-reveal"); waitDom(".flashcards-ratings")
                until("four enabled rating controls") { js("document.querySelectorAll('.flashcards-ratings>button:not(:disabled)').length===4") == true }
                checkResult("all review ratings remain reachable without grading", js("(()=>{const buttons=[...document.querySelectorAll('.flashcards-ratings>button')];return buttons.length===4&&buttons.every(e=>{const r=e.getBoundingClientRect(),top=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return e.checkVisibility()&&r.height>=44&&r.top>=0&&r.bottom<=innerHeight+2&&(e===top||e.contains(top))})})()") == true)
                screenshot("03-review-ratings"); click("[aria-label='退出复习']")
            } else evidence.put("reviewSampleLimit", "No current due-card sample; no cards were graded or manufactured.")
            clickText("牌库", ".mobile-flashcard-tabs button"); waitDom(".mobile-page-library")
            if (dom(".mobile-page-library .mobile-flashcard-row")) {
                click(".mobile-page-library .mobile-flashcard-row"); waitDom("[aria-label='新建卡片']")
                if (!before.has("hub.flashcards.editor-draft-v1")) {
                    click("[aria-label='新建卡片']"); waitDom(".flashcards-card-modal")
                    click("[data-editor-question]"); until("flashcard keyboard visible") { keyboard() }
                    field("[data-editor-question]", "Hub 界面验收未保存闪卡")
                    checkResult("flashcard save remains fixed above the keyboard", js("(()=>{const r=document.querySelector('.flashcards-card-modal-save').getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight+2})()") == true)
                    evidence.put("editorBottomControls", js("[...document.querySelectorAll('.mobile-navigation-footer,.flashcards-card-editor-actions')].map(e=>({class:e.className,visible:e.checkVisibility(),display:getComputedStyle(e).display}))"))
                    checkResult("full screen card editor hides duplicate bottom navigation and save bar", js("[...document.querySelectorAll('.mobile-navigation-footer,.flashcards-card-editor-actions')].every(e=>!e.checkVisibility())") == true)
                    screenshot("04-flashcard-editor")
                    if (keyboard()) back(); back()
                    until("unsaved card confirmation") { js("[...document.querySelectorAll('button')].some(b=>b.textContent==='保留草稿'&&b.checkVisibility())") == true }
                    clickText("保留草稿"); until("flashcard editor closed") { !dom(".flashcards-card-modal") }
                    clickText("找回草稿"); waitDom(".flashcards-card-modal")
                    checkResult("leaving the editor preserves the same unsaved question", js("document.querySelector('[data-editor-question]').value") == "Hub 界面验收未保存闪卡")
                    click(".flashcards-card-modal-header-actions [title='关闭']"); clickText("保留草稿")
                } else evidence.put("editorSampleLimit", "An existing personal card draft was preserved; it was not replaced.")
            } else evidence.put("editorSampleLimit", "No existing deck is available for editor navigation.")
            click("nav[aria-label='主要导航'] button[aria-label='搜索']"); waitDom(".mobile-search-compact-filters")
            asyncJs("const {userProfileStorage:s,flushUserProfileStorage:flush}=await import(new URL('/src/UserProfileStorage.ts',location.href).href);s.setItem('hub.mobile.appearance.v1',JSON.stringify({theme:'black',accent:'iris'}));await flush();return true")
            until("real dark appearance applied") { js("document.documentElement.dataset.mobileTheme") == "black" }
            val contrast = js("(()=>{const rgb=s=>(s.match(/[\\d.]+/g)||[]).map(Number),lum=a=>a.slice(0,3).map(v=>v/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4).reduce((s,v,i)=>s+v*[.2126,.7152,.0722][i],0);return[...document.querySelectorAll('.section-label-text,.result-title,.grouped-page-title,.grouped-page-summary')].filter(e=>e.checkVisibility()).map(e=>{const fg=rgb(getComputedStyle(e).color);let p=e,bg=[];while(p){bg=rgb(getComputedStyle(p).backgroundColor);if(bg.length===3||bg[3]>.95)break;p=p.parentElement}const a=lum(fg),b=lum(bg);return{class:e.className,ratio:(Math.max(a,b)+.05)/(Math.min(a,b)+.05)}})})()") as JSONArray
            evidence.put("darkTextContrast", contrast)
            checkResult("dark search title and count remain readable", contrast.length()>0 && (0 until contrast.length()).all { contrast.getJSONObject(it).getDouble("ratio")>=4.5 })
            screenshot("05-dark-search")
            val density = (js("devicePixelRatio") as Number).toDouble()
            shell("wm size ${(320*density).toInt()}x${(640*density).toInt()}")
            until("native narrow viewport") { (js("innerWidth") as Number).toInt() <= 322 }
            evidence.put("narrowGeometry", js("[...document.querySelectorAll('.mobile-top-area,.search-header,.search-box,.mobile-search-facets,.mobile-search-compact-filters,.results-pane,.result-item,.results-summary,.result-group-header,nav[aria-label=主要导航]')].map(e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);return{class:e.className,x:r.x,width:r.width,right:r.right,display:s.display,minWidth:s.minWidth,color:s.color,background:s.backgroundColor}})"))
            checkResult("320 CSS px has no horizontal overflow", js("document.documentElement.scrollWidth<=innerWidth+1") == true)
            screenshot("06-dark-320")
            evidence.put("completed", true)
        } catch (failure: Throwable) { evidence.put("failure", failure.toString()); screenshot("failure"); throw failure }
        finally {
            shell(if (override != null) "wm size $override" else "wm size reset")
            try {
                if (dom(".flashcards-card-modal") && js("document.querySelector('[data-editor-question]')?.value") == "Hub 界面验收未保存闪卡") {
                    if (keyboard()) back()
                    click(".flashcards-card-modal-header-actions [title='关闭']")
                    if (js("[...document.querySelectorAll('button')].some(e=>e.textContent==='保留草稿'&&e.checkVisibility())") == true) clickText("保留草稿")
                    until("test card editor unmounted before restoring profile") { !dom(".flashcards-card-modal") }
                }
                if (ownedDeck.isNotEmpty()) { native("delete_flashcard_deck", JSONObject().put("deckId", ownedDeck)); evidence.put("temporaryDeckRemoved", true) }
                asyncJs("const {userProfileStorage:s,flushUserProfileStorage:flush}=await import(new URL('/src/UserProfileStorage.ts',location.href).href);await flush();const before=$before;for(let i=s.length-1;i>=0;i--){const k=s.key(i);if((k.startsWith('hub.flashcards.')||k==='hub.mobile.appearance.v1')&&!(k in before))s.removeItem(k)}for(const [k,v] of Object.entries(before))s.setItem(k,v);await flush();return true")
                if (searchValue != null && dom(".search-box input")) field(".search-box input", searchValue)
                evidence.put("originalProfileRestored", true)
            } catch (restore: Throwable) { evidence.put("restoreFailure", restore.toString()); evidence.put("completed", false) }
            File(directory, "result.json").writeText(evidence.toString(2), Charsets.UTF_8)
        }
    }
}
