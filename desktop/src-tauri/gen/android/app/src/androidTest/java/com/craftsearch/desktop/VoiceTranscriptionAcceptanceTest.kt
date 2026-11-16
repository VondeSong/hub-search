package com.craftsearch.desktop

import android.app.Activity
import android.content.Intent
import android.graphics.Bitmap
import android.os.SystemClock
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.webkit.WebView
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.runner.lifecycle.ActivityLifecycleMonitorRegistry
import androidx.test.runner.lifecycle.Stage
import org.json.JSONArray
import org.json.JSONObject
import org.json.JSONTokener
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/** Opt-in real service test. Restores the user's exact voice draft and never saves a journal record. */
@RunWith(AndroidJUnit4::class)
class VoiceTranscriptionAcceptanceTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private lateinit var activity: Activity
    private lateinit var web: WebView
    private val runId = InstrumentationRegistry.getArguments().getString("acceptanceRunId") ?: System.currentTimeMillis().toString()
    private val directory by lazy { File(instrumentation.targetContext.getExternalFilesDir(null), "voice-asr-acceptance/$runId").apply { mkdirs() } }
    private val checks = JSONArray()
    private fun until(name: String, seconds: Int = 40, condition: () -> Boolean) {
        val deadline = SystemClock.elapsedRealtime() + seconds * 1000
        while (SystemClock.elapsedRealtime() < deadline) { if (condition()) return; SystemClock.sleep(150) }
        error("Timed out: $name")
    }
    private fun find(view: View): WebView? { if (view is WebView) return view; if (view is ViewGroup) for (i in 0 until view.childCount) find(view.getChildAt(i))?.let { return it }; return null }
    private fun js(code: String): Any? {
        val latch = CountDownLatch(1); var result: Any? = null
        instrumentation.runOnMainSync { web.evaluateJavascript("(()=>{try{return ($code)}catch(e){return {failure:String(e)}}})()") { value -> result = JSONTokener(value).nextValue(); latch.countDown() } }
        check(latch.await(15, TimeUnit.SECONDS)); check((result as? JSONObject)?.has("failure") != true) { result.toString() }
        return result
    }
    private fun native(command: String, args: JSONObject = JSONObject()): Any? {
        js("(()=>{window.__voiceQa={done:false};window.__TAURI_INTERNALS__.invoke(${JSONObject.quote(command)},$args).then(value=>window.__voiceQa={done:true,value},error=>window.__voiceQa={done:true,error:String(error)});return true})()")
        until("native $command", 180) { js("window.__voiceQa?.done===true") == true }
        val result = js("window.__voiceQa") as JSONObject
        check(!result.has("error")) { result.optString("error") }; return result.opt("value")
    }
    private fun click(expression: String) {
        until("target app owns input focus") {
            var focused = false; instrumentation.runOnMainSync { focused = activity.hasWindowFocus() }; focused
        }
        js("(()=>{const e=$expression;if(!e)throw Error('Missing control');e.scrollIntoView({block:'center',behavior:'instant'});return true})()")
        SystemClock.sleep(250)
        val rect = js("(()=>{const e=$expression;if(!e||e.disabled||!e.checkVisibility())throw Error('Unavailable control');const r=e.getBoundingClientRect();const top=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);if(!(e===top||e.contains(top)))throw Error('Control covered');return {x:r.x+r.width/2,y:r.y+r.height/2,dpr:devicePixelRatio}})()") as JSONObject
        val location = IntArray(2); instrumentation.runOnMainSync { web.getLocationOnScreen(location) }
        val x = (rect.getDouble("x") * rect.getDouble("dpr") + location[0]).toFloat(); val y = (rect.getDouble("y") * rect.getDouble("dpr") + location[1]).toFloat()
        val now = SystemClock.uptimeMillis()
        check(instrumentation.uiAutomation.injectInputEvent(MotionEvent.obtain(now, now, MotionEvent.ACTION_DOWN, x, y, 0), true))
        check(instrumentation.uiAutomation.injectInputEvent(MotionEvent.obtain(now, now + 50, MotionEvent.ACTION_UP, x, y, 0), true))
    }
    private fun selector(value: String) = "document.querySelector(${JSONObject.quote(value)})"
    private fun button(text: String) = "[...document.querySelectorAll('.journal-voice-dialog button')].find(b=>b.textContent.trim()===${JSONObject.quote(text)})"
    private fun checkResult(name: String, passed: Boolean) { checks.put(JSONObject().put("name", name).put("passed", passed)); File(directory, "checks.json").writeText(checks.toString(2)); check(passed) { name } }
    private fun screenshot(name: String) {
        val drawn = CountDownLatch(1)
        instrumentation.runOnMainSync {
            web.postVisualStateCallback(SystemClock.uptimeMillis(), object : WebView.VisualStateCallback() {
                override fun onComplete(requestId: Long) { web.postOnAnimation { web.postOnAnimation { drawn.countDown() } } }
            })
        }
        check(drawn.await(12, TimeUnit.SECONDS)); instrumentation.waitForIdleSync()
        instrumentation.uiAutomation.takeScreenshot()?.let { image -> File(directory, "$name.png").outputStream().use { image.compress(Bitmap.CompressFormat.PNG, 100, it) }; image.recycle() }
    }
    private fun visibleHeader(): Boolean = js("(()=>{const d=document.querySelector('.journal-voice-dialog'),h=d.querySelector(':scope>header'),x=d.querySelector('[aria-label=\"保留语音草稿并关闭\"]'),p=d.getBoundingClientRect(),r=h.getBoundingClientRect(),b=x.getBoundingClientRect(),top=document.elementFromPoint(b.x+b.width/2,b.y+b.height/2);return r.height>0&&r.top>=p.top-1&&b.top>=p.top&&b.bottom<=p.bottom&&(top===x||x.contains(top))})()") == true

    private fun launch() {
        instrumentation.targetContext.startActivity(Intent(instrumentation.targetContext, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        until("activity") { instrumentation.runOnMainSync { ActivityLifecycleMonitorRegistry.getInstance().getActivitiesInStage(Stage.RESUMED).firstOrNull { it is MainActivity }?.let { activity = it } }; ::activity.isInitialized }
        until("WebView") { instrumentation.runOnMainSync { find(activity.window.decorView)?.let { web = it } }; ::web.isInitialized }
        until("application", 90) { js("!!document.querySelector('.mobile-app-shell')") == true }
    }

    @Test fun restoreOriginalVoiceDraft() {
        val previous = InstrumentationRegistry.getArguments().getString("recoveryRunId") ?: error("Explicit prior run required")
        check(previous.matches(Regex("voice-asr-[0-9]{8}-[0-9]{6}")))
        val original = File(instrumentation.targetContext.getExternalFilesDir(null), "voice-asr-acceptance/$previous/original-draft.json").readText()
        launch()
        val status = native("quick_journal_voice", JSONObject().put("action", "status")) as JSONObject
        check(status.getString("state") == "idle") { "A pending original must be handled first" }
        native("quick_journal_voice_draft", JSONObject().put("value", original))
        checkResult("prior draft recovered exactly after blocked permission flow", native("quick_journal_voice_draft") == original)
    }

    @Test fun voiceLongTranscriptLayout() {
        val previous = InstrumentationRegistry.getArguments().getString("replayRunId") ?: error("Explicit completed run required")
        check(previous.matches(Regex("voice-asr-[0-9]{8}-[0-9]{6}")))
        val identity = JSONObject(File(instrumentation.targetContext.getExternalFilesDir(null), "voice-asr-acceptance/$previous/result.json").readText()).getString("recordId")
        launch()
        val original = native("quick_journal_voice_draft") as String
        File(directory, "original-draft.json").writeText(original)
        try {
            val archived = JSONArray(native("quick_journal_voice_draft", JSONObject().put("recordId", identity)) as String)
            check(archived.length() == 2 && archived.getJSONObject(0).getString("state") == "completed")
            val source = File(instrumentation.targetContext.getExternalFilesDir(null), "voice-asr-input.wav")
            val attachment = native("stage_quick_journal_attachment", JSONObject().put("name", "转写验收语音.wav").put("content", android.util.Base64.encodeToString(source.readBytes(), android.util.Base64.NO_WRAP))) as JSONObject
            val record = JSONObject().put("version", 1).put("id", identity).put("date", "2026-11-16").put("text", "本轮转写验收：已有结果的长内容检查。").put("attachments", JSONArray().put(attachment))
            native("quick_journal_voice_draft", JSONObject().put("value", JSONObject().put("record", record).put("stagedTokens", JSONArray()).put("transcripts", archived).toString()))
            js("window.dispatchEvent(new CustomEvent('hub:journal-voice',{detail:{}}))")
            until("archived cards") { js("document.querySelectorAll('.journal-transcript').length===2") == true }
            js("document.querySelectorAll('.journal-transcript')[1].scrollIntoView({block:'end',behavior:'instant'})")
            screenshot("long-content-header")
            File(directory, "geometry.json").writeText(js("(()=>{const d=document.querySelector('.journal-voice-dialog');return{dialog:d.getBoundingClientRect().toJSON(),header:d.querySelector(':scope>header').getBoundingClientRect().toJSON(),scrollTop:d.scrollTop,overflow:getComputedStyle(d).overflow}})()").toString())
            checkResult("long content keeps header inside its clipping parent and close actually clickable", visibleHeader())
        } finally {
            if (js("!!document.querySelector('.journal-voice-dialog[open]')") == true) {
                click(selector("[aria-label='保留语音草稿并关闭']"))
                until("voice closes") { js("!document.querySelector('.journal-voice-dialog[open]')") == true }
            }
            native("quick_journal_voice_draft", JSONObject().put("value", original))
            checkResult("layout check restores user's exact previous draft", native("quick_journal_voice_draft") == original)
            File(directory, "result.json").writeText(JSONObject().put("checks", checks).put("reusedExistingServiceResults", true).toString(2))
        }
    }

    @Test fun voiceAsrRoundTrip() {
        // Prepare this emulator's runtime permission; never wait on a system dialog in a parked IPC.
        instrumentation.uiAutomation.grantRuntimePermission(instrumentation.targetContext.packageName, android.Manifest.permission.RECORD_AUDIO)
        launch()
        val status = native("quick_journal_voice", JSONObject().put("action", "status")) as JSONObject
        check(status.getString("state") == "idle") { "An existing recording is pending; leave it untouched" }
        val original = native("quick_journal_voice_draft") as String
        File(directory, "original-draft.json").writeText(original)
        val recordId = java.util.UUID.randomUUID().toString().replace("-", "")
        val jobs = mutableListOf<String>()
        var opened = false
        var originalProvider = ""
        try {
            val source = File(instrumentation.targetContext.getExternalFilesDir(null), "voice-asr-input.wav")
            check(source.isFile && source.length() in 1..(20L * 1024 * 1024)) { "Explicit controlled audio fixture required" }
            val attachment = native("stage_quick_journal_attachment", JSONObject().put("name", "转写验收语音.wav").put("content", android.util.Base64.encodeToString(source.readBytes(), android.util.Base64.NO_WRAP))) as JSONObject
            val record = JSONObject().put("version", 1).put("id", recordId).put("date", "2026-11-16").put("text", "本轮转写验收：已有文字保持不变。").put("attachments", JSONArray().put(attachment))
            native("quick_journal_voice_draft", JSONObject().put("value", JSONObject().put("record", record).put("stagedTokens", JSONArray()).toString()))
            js("window.dispatchEvent(new CustomEvent('hub:journal-voice',{detail:{}}))"); opened = true
            until("services configured") { js("document.querySelector('.journal-voice-service small')?.textContent==='已配置'") == true }
            originalProvider = InstrumentationRegistry.getArguments().getString("restoreVoiceProvider") ?: js("document.querySelector('[aria-label=\"转写服务\"]').value").toString()
            screenshot("01-ready")
            for (provider in listOf("aliyun", "openai")) {
                js("(()=>{const e=document.querySelector('[aria-label=\"转写服务\"]');e.value=${JSONObject.quote(provider)};e.dispatchEvent(new Event('change',{bubbles:true}));return true})()")
                until("provider changed") { js("document.querySelector('[aria-label=\"转写服务\"]').value===${JSONObject.quote(provider)}") == true }
                val label = if (provider == "aliyun") "用阿里补转写" else "用OpenAI补转写"
                click(button(label))
                until("$provider actual transcription", 240) { js("[...document.querySelectorAll('.journal-transcript')].some(e=>e.getAttribute('aria-label').startsWith(${JSONObject.quote(if(provider=="aliyun") "阿里" else "OpenAI")})&&e.querySelector('[role=status]')?.textContent==='已完成')") == true }
                val draft = JSONObject(native("quick_journal_voice_draft") as String)
                val transcripts = draft.getJSONArray("transcripts")
                val result = (0 until transcripts.length()).map { transcripts.getJSONObject(it) }.first { it.getString("provider") == provider }
                jobs.add(result.getString("id"))
                checkResult("$provider returned real Chinese transcript", result.getString("text").contains("连接器"))
                checkResult("$provider did not overwrite existing notes", draft.getJSONObject("record").getString("text") == record.getString("text"))
                File(directory, "$provider.json").writeText(result.toString(2))
                screenshot("02-$provider-result")
            }
            checkResult("header and close control remain visible with two long transcripts", visibleHeader())
            js("(()=>{const e=document.querySelector('.journal-transcript textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,'已校对：保留原音和已有文字。');e.dispatchEvent(new Event('input',{bubbles:true}));return true})()")
            click(button("加入补充文字"))
            until("corrected text applied") { js("document.querySelector('[aria-label=\"录音补充文字\"]').value.includes('已校对：保留原音和已有文字。')") == true }
            checkResult("confirmed text appended once", js("document.querySelector('[aria-label=\"录音补充文字\"]').value.split('已校对：').length===2&&document.querySelector('.journal-transcript-actions button').disabled") == true)
            // Check microphone capture locally; never upload ambient host audio as a speech fixture.
            native("quick_journal_voice", JSONObject().put("action", "start"))
            until("microphone recording") { js("document.querySelector('.journal-voice-clock span')?.textContent==='正在录音'") == true }
            SystemClock.sleep(2500); click(button("暂停")); SystemClock.sleep(500)
            val clock = js("document.querySelector('.journal-voice-clock strong').textContent")
            SystemClock.sleep(1600)
            checkResult("pause excludes elapsed time", js("document.querySelector('.journal-voice-clock strong').textContent") == clock)
            click(button("继续录音")); SystemClock.sleep(2200); click(button("完成本段"))
            until("original staged", 90) { (native("quick_journal_voice", JSONObject().put("action", "status")) as JSONObject).getString("state") == "idle" }
            val finalDraft = JSONObject(native("quick_journal_voice_draft") as String)
            checkResult("new microphone original retained beside fixture", finalDraft.getJSONObject("record").getJSONArray("attachments").length() == 2)
            val captured = finalDraft.getJSONObject("record").getJSONArray("attachments").getJSONObject(1)
            val playback = native("quick_journal_audio", JSONObject().put("hash", captured.getString("hash"))) as String
            val originalAudio = File(directory, "microphone-original.m4a")
            originalAudio.writeBytes(android.util.Base64.decode(playback.substringAfter(','), android.util.Base64.DEFAULT))
            val extractor = android.media.MediaExtractor()
            try {
                extractor.setDataSource(originalAudio.absolutePath)
                val format = extractor.getTrackFormat(0)
                checkResult("captured original is playable mono AAC at 24 kHz", format.getInteger(android.media.MediaFormat.KEY_SAMPLE_RATE) == 24000 && format.getInteger(android.media.MediaFormat.KEY_CHANNEL_COUNT) == 1 && format.getString(android.media.MediaFormat.KEY_MIME) == "audio/mp4a-latm")
                File(directory, "microphone-format.json").writeText(JSONObject().put("sampleRate", 24000).put("channels", 1).put("durationUs", format.getLong(android.media.MediaFormat.KEY_DURATION)).put("size", originalAudio.length()).toString(2))
            } finally { extractor.release() }
            val archived = JSONArray(native("quick_journal_voice_draft", JSONObject().put("recordId", recordId)) as String)
            checkResult("transcript receipts remain attached to the same saved-record identity", archived.length() == 2 && archived.getJSONObject(0).optString("edited").startsWith("已校对"))
            screenshot("03-microphone-retained")
        } finally {
            if (opened) {
                if (originalProvider in listOf("aliyun", "openai")) {
                    js("(()=>{const e=document.querySelector('[aria-label=\"转写服务\"]');e.value=${JSONObject.quote(originalProvider)};e.dispatchEvent(new Event('change',{bubbles:true}));return true})()")
                    checkResult("original service preference restored", js("document.querySelector('[aria-label=\"转写服务\"]').value===${JSONObject.quote(originalProvider)}") == true)
                }
                click(selector("[aria-label='保留语音草稿并关闭']"))
                until("voice closes", 90) { js("!document.querySelector('.journal-voice-dialog[open]')") == true }
            }
            // No new record is submitted; restore the user's previous draft byte-for-byte.
            native("quick_journal_voice_draft", JSONObject().put("value", original))
            checkResult("prior voice draft restored exactly", native("quick_journal_voice_draft") == original)
            File(directory, "result.json").writeText(JSONObject().put("checks", checks).put("jobs", JSONArray(jobs)).put("recordId", recordId).toString(2))
        }
    }
}
