plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}
android {
    namespace = "com.veltrix.live"
    compileSdk = 35
    defaultConfig {
        applicationId = "com.veltrix.live"
        minSdk = 26
        targetSdk = 30
        versionCode = 1
        versionName = "0.1.0"
    }
}
dependencies {
    implementation("com.microsoft.signalr:signalr:8.0.7")
    implementation("com.google.code.gson:gson:2.11.0")
}
