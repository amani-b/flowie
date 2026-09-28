package app.flowie;

import static org.junit.Assert.*;

import android.content.Context;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import org.junit.Test;
import org.junit.runner.RunWith;

/**
 * Instrumented test, which will execute on an Android device.
 *
 * This one carries a real assertion: the installed package name must be
 * `app.flowie`. That is the exact identity `cap add android` got wrong the first
 * time (it fell back to `com.getcapacitor.app` when the platform was added
 * before `@capacitor/android` was installed — see §9, Phase 5 lesson 2), so it
 * is worth guarding on a device even though the class is otherwise a template.
 *
 * NOT run in CI: it needs an attached device or an emulator, and the project
 * deliberately installs neither (see docs/IMPLEMENTER_HANDOFF.md). It compiles
 * under `./gradlew :app:assembleDebugAndroidTest` and runs under
 * `./gradlew :app:connectedDebugAndroidTest` on a handset.
 *
 * @see <a href="http://d.android.com/tools/testing">Testing documentation</a>
 */
@RunWith(AndroidJUnit4.class)
public class ExampleInstrumentedTest {

    @Test
    public void useAppContext() throws Exception {
        // Context of the app under test.
        Context appContext = InstrumentationRegistry.getInstrumentation().getTargetContext();

        assertEquals("app.flowie", appContext.getPackageName());
    }
}
