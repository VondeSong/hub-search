plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// A separate process can test a genuinely reclaimed client without killing its runner.
android {
    namespace = "com.craftsearch.desktop.acceptance"
    compileSdk = 36
    defaultConfig {
        applicationId = "com.craftsearch.desktop.acceptance"
        minSdk = 24
        targetSdk = 36
        versionCode = 1
        versionName = "1"
    }
    kotlinOptions { jvmTarget = "1.8" }
}

dependencies {
    implementation("androidx.test.ext:junit:1.1.4")
    implementation("androidx.test.espresso:espresso-core:3.5.0")
}
