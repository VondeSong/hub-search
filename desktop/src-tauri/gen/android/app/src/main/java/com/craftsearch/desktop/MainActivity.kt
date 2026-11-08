package com.craftsearch.desktop

import android.os.Bundle
import java.io.File
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat

class MainActivity : TauriActivity() {
  // Android's /data/user/0 alias must be resolved before native data-safety checks.
  override fun getDataDir(): File = super.getDataDir().canonicalFile

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)

    val content = findViewById<android.view.View>(android.R.id.content)
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
    // Tauri invokes this fallback after the WebView history is exhausted.
    // Keep the root task available for resume instead of tearing down the Rust runtime.
    moveTaskToBack(true)
  }
}
