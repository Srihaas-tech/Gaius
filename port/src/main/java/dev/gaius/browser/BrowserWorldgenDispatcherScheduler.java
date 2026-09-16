package dev.gaius.browser;

import java.util.concurrent.Executor;
import org.teavm.platform.Platform;
import org.teavm.platform.PlatformRunnable;

/** Resumes the integrated-server worldgen dispatcher in a fresh Worker turn. */
public final class BrowserWorldgenDispatcherScheduler {
    private BrowserWorldgenDispatcherScheduler() {
    }

    public static void defer(Executor executor, Runnable dispatcher) {
        Platform.startThread(new DeferredExecution(executor, dispatcher));
    }

    private static final class DeferredExecution implements PlatformRunnable {
        private final Executor executor;
        private final Runnable dispatcher;

        private DeferredExecution(Executor executor, Runnable dispatcher) {
            this.executor = executor;
            this.dispatcher = dispatcher;
        }

        @Override
        public void run() {
            executor.execute(dispatcher);
        }
    }
}
