package app.flowie;

import static org.junit.Assert.*;

import org.junit.Test;

/**
 * Local JVM unit test — the placeholder Capacitor's template ships, kept
 * deliberately (see docs/ENGINEERING_EXECUTION_SPEC.md §9, Phase 5 carry-forward
 * 1). It is not a claim about app behaviour: the Android shell is a bare
 * `BridgeActivity` subclass with no logic of its own. Its only job is to keep
 * the `test` source set non-empty so CI compiles it, which is what catches a
 * broken `testImplementation`/AGP test wiring before it silently rots.
 *
 * @see <a href="http://d.android.com/tools/testing">Testing documentation</a>
 */
public class ExampleUnitTest {

    @Test
    public void addition_isCorrect() throws Exception {
        assertEquals(4, 2 + 2);
    }
}
