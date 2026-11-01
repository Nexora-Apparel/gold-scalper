plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}
android {
    buildFeatures { buildConfig = true }
    namespace = "com.veltrix.live"
    compileSdk = 35
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
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
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("androidx.security:security-crypto:1.1.0-alpha06")
}
