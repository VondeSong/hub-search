package com.craftsearch.desktop

import android.os.Bundle
import android.webkit.WebView
import java.io.File
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.core.graphics.Insets

class MainActivity : TauriActivity() {
  private var hubWebView: WebView? = null

  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
    hubWebView = webView
  }
  // Android's /data/user/0 alias must be resolved before native data-safety checks.
  override fun getDataDir(): File = super.getDataDir().canonicalFile

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)

    val content = findViewById<android.view.View>(android.R.id.content)
    val bottomPadding = content.paddingBottom
    ViewCompat.setOnApplyWindowInsetsListener(content) { view, insets ->
      // Edge-to-edge WebViews can keep a full-height viewport above the IME.
      val ime = WindowInsetsCompat.Type.ime()
      view.setPadding(view.paddingLeft, view.paddingTop, view.paddingRight,
        bottomPadding + insets.getInsets(ime).bottom)
      WindowInsetsCompat.Builder(insets).setInsets(ime, Insets.NONE).build()
    }
    ViewCompat.requestApplyInsets(content)
    val keyboardBack = object : OnBackPressedCallback(false) {
      override fun handleOnBackPressed() {
        WindowInsetsControllerCompat(window, content).hide(WindowInsetsCompat.Type.ime())
      }
    }
    var keyboardVisible = false
    content.viewTreeObserver.addOnGlobalLayoutListener {
      val visible = ViewCompat.getRootWindowInsets(content)
        ?.isVisible(WindowInsetsCompat.Type.ime()) == true
      if (visible && !keyboardVisible) {
        // Register after Tauri's WebView callback so Back dismisses the IME first.
        keyboardBack.remove()
        onBackPressedDispatcher.addCallback(this, keyboardBack)
      }
      keyboardBack.isEnabled = visible
      keyboardVisible = visible
    }
  }

  @Suppress("DEPRECATION", "OVERRIDE_DEPRECATION")
  override fun onBackPressed() {
    // Legacy Back reaches this override before AndroidX's history callback.
    val content = findViewById<android.view.View>(android.R.id.content)
    if (content != null && ViewCompat.getRootWindowInsets(content)
        ?.isVisible(WindowInsetsCompat.Type.ime()) == true) {
      WindowInsetsControllerCompat(window, content).hide(WindowInsetsCompat.Type.ime())
      return
    }
    val webView = hubWebView
    if (webView?.canGoBack() == true) webView.goBack()
    else moveTaskToBack(true)
  }
}
