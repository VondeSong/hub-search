package com.craftsearch.desktop

import android.os.Bundle
import android.os.Looper
import android.content.Intent
import android.webkit.WebView
import java.io.File
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.core.graphics.Insets

class MainActivity : TauriActivity() {
  private val activityInstance = System.identityHashCode(this)
  private external fun activityLifecycle(instance: Int, stage: Int)
  private var hubWebView: WebView? = null
  private var pendingJournalKeyboard = false
  private var journalKeyboardGeneration = 0

  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
    hubWebView = webView
    activityLifecycle(activityInstance, 2)
    // Keep the editor's DOM focus when Android requests focus during IME/layout changes.
    webView.settings.setNeedInitialFocus(false)
    onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
      override fun handleOnBackPressed() { handleHubBack() }
    })
  }
  // Android's /data/user/0 alias must be resolved before native data-safety checks.
  override fun getDataDir(): File = super.getDataDir().canonicalFile

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    activityLifecycle(activityInstance, 1)
    rememberJournalAction(intent)

    val content = findViewById<android.view.View>(android.R.id.content)
    val basePadding = intArrayOf(content.paddingLeft, content.paddingTop, content.paddingRight, content.paddingBottom)
    ViewCompat.setOnApplyWindowInsetsListener(content) { view, insets ->
      // Resize once for the IME, then prevent descendants from applying it again.
      val ime = WindowInsetsCompat.Type.ime()
      val bars = WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout()
      val safe = insets.getInsets(bars)
      view.setPadding(basePadding[0] + safe.left, basePadding[1] + safe.top,
        basePadding[2] + safe.right, basePadding[3] + maxOf(insets.getInsets(ime).bottom, safe.bottom))
      WindowInsetsCompat.Builder(insets).setInsets(ime, Insets.NONE).setInsets(bars, Insets.NONE).build()
    }
    ViewCompat.requestApplyInsets(content)
  }

  private fun rememberJournalAction(incoming: Intent?) {
    val data = incoming?.data
    val record = if (data?.scheme == "hub" && data.host == "journal") data.lastPathSegment else null
    val action = if (incoming?.action == JournalTileService.JOURNAL_CAPTURE_ACTION) "capture" else if (record?.matches(Regex("[a-f0-9]{32}")) == true) "record" else return
    getSharedPreferences("journal-entry", MODE_PRIVATE).edit().putString("action", action).putString("recordId", record ?: "").commit()
    hubWebView?.post { hubWebView?.evaluateJavascript("window.dispatchEvent(new Event('hub:journal-action-available'))", null) }
    incoming?.action = null
    if (action == "record") incoming?.data = null
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    setIntent(intent)
    rememberJournalAction(intent)
  }

  override fun onStop() {
    // No foreground service in this phase: finalize rather than silently lose background audio.
    runCatching { JournalVoiceRecorder.stop(this) }
    super.onStop()
  }

  override fun onDestroy() {
    activityLifecycle(activityInstance, 3)
    hubWebView = null
    super.onDestroy()
    // Wry queues its callback removal on the Android looper during super.onDestroy().
    // Wait for that queue to drain before reusing the same Tauri WebView label.
    val destroyedInstance = activityInstance
    Looper.myQueue().addIdleHandler {
      activityLifecycle(destroyedInstance, 4)
      false
    }
  }

  internal fun dismissJournalKeyboard() {
    pendingJournalKeyboard = false
    journalKeyboardGeneration++
    hubWebView?.let { WindowInsetsControllerCompat(window, it).hide(WindowInsetsCompat.Type.ime()) }
  }

  internal fun requestJournalKeyboard(done: () -> Unit) {
    val generation = ++journalKeyboardGeneration
    val web = hubWebView
    if (web == null || !hasWindowFocus()) { pendingJournalKeyboard = true; done(); return }
    pendingJournalKeyboard = false
    web.requestFocusFromTouch()
    web.post {
      web.evaluateJavascript("""
        (() => {
          const dialogs = [...document.querySelectorAll('dialog[open]')];
          const editor = dialogs[dialogs.length - 1]?.querySelector('.journal-rich-editor[contenteditable=true]');
          if (!editor) return false;
          editor.focus({preventScroll:true});
          return document.activeElement === editor;
        })()
      """.trimIndent()) { editing ->
        if (generation == journalKeyboardGeneration && editing == "true" && hasWindowFocus()) {
          val manager = getSystemService(android.view.inputmethod.InputMethodManager::class.java)
          if (!manager.isActive(web)) manager.restartInput(web)
          WindowInsetsControllerCompat(window, web).show(WindowInsetsCompat.Type.ime())
        }
        done()
      }
    }
  }

  override fun onWindowFocusChanged(hasFocus: Boolean) {
    super.onWindowFocusChanged(hasFocus)
    if (hasFocus && pendingJournalKeyboard) requestJournalKeyboard {}
  }

  @Suppress("DEPRECATION", "OVERRIDE_DEPRECATION")
  override fun onBackPressed() {
    handleHubBack()
  }

  private fun handleHubBack() {
    val content = findViewById<android.view.View>(android.R.id.content)
    if (content != null && ViewCompat.getRootWindowInsets(content)
        ?.isVisible(WindowInsetsCompat.Type.ime()) == true) {
      WindowInsetsControllerCompat(window, content).hide(WindowInsetsCompat.Type.ime())
      return
    }
    val webView = hubWebView
    if (webView == null) { moveTaskToBack(true); return }
    webView.evaluateJavascript("""
      (() => {
        const event = new Event('hub:native-back', {cancelable:true});
        if (!window.dispatchEvent(event)) return true;
        const dialogs = [...document.querySelectorAll('dialog[open]')];
        const dialog = dialogs[dialogs.length - 1];
        if (!dialog) return false;
        if (dialog.dispatchEvent(new Event('cancel', {cancelable:true}))) dialog.close();
        return true;
      })()
    """.trimIndent()) { handled ->
      // App history also includes entries opened without a WebView touch gesture.
      if (handled != "true") {
        if (webView.canGoBack()) webView.evaluateJavascript("window.history.back()", null)
        else moveTaskToBack(true)
      }
    }
  }
}
