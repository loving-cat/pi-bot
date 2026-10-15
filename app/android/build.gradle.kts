allprojects {
    repositories {
        google()
        mavenCentral()
    }
}

val newBuildDir: Directory =
    rootProject.layout.buildDirectory
        .dir("../../build")
        .get()
rootProject.layout.buildDirectory.value(newBuildDir)

subprojects {
    val newSubprojectBuildDir: Directory = newBuildDir.dir(project.name)
    project.layout.buildDirectory.value(newSubprojectBuildDir)
}

// 插件模块（file_picker / image_picker / flutter_plugin_android_lifecycle 等）
// 默认跟着 Flutter 的 compileSdk 走，会把整体卡在 35，这里统一提到 36。
// 必须在 evaluationDependsOn(":app") 之前注册 afterEvaluate，否则子项目已经评估完了。
subprojects {
    afterEvaluate {
        val ext = extensions.findByName("android")
        if (ext is com.android.build.gradle.BaseExtension) {
            val current = ext.compileSdkVersion?.removePrefix("android-")?.toIntOrNull() ?: 0
            if (current < 36) ext.compileSdkVersion(36)
        }
    }
}

subprojects {
    project.evaluationDependsOn(":app")
}

tasks.register<Delete>("clean") {
    delete(rootProject.layout.buildDirectory)
}
