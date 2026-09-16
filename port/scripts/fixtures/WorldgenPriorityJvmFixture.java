import java.util.ArrayDeque;
import java.util.Queue;
import java.util.concurrent.Executor;
import java.util.concurrent.atomic.AtomicInteger;
import net.minecraft.util.thread.PriorityConsecutiveExecutor;
import org.teavm.platform.Platform;

public final class WorldgenPriorityJvmFixture {
    private static final class Gate implements Executor {
        private final Queue<Runnable> pending = new ArrayDeque<>();
        private boolean draining;

        @Override
        public void execute(Runnable command) {
            if (draining) {
                command.run();
            } else {
                pending.add(command);
            }
        }

        void drainOne() {
            Runnable command = pending.poll();
            if (command == null) {
                throw new AssertionError("executor command was not registered");
            }
            draining = true;
            try {
                command.run();
            } finally {
                draining = false;
            }
        }

        int pendingCount() {
            return pending.size();
        }
    }

    public static void main(String[] args) {
        Gate gate = new Gate();
        PriorityConsecutiveExecutor dispatcher =
                new PriorityConsecutiveExecutor(4, gate, "worldgen-dispatcher");
        AtomicInteger count = new AtomicInteger();
        final int taskCount = 4_096;
        for (int i = 0; i < taskCount; i++) {
            int expected = i;
            dispatcher.schedule(dispatcher.wrapRunnable(() -> {
                int actual = count.getAndIncrement();
                if (actual != expected) {
                    throw new AssertionError("FIFO mismatch: expected " + expected + " got " + actual);
                }
            }));
        }
        gate.drainOne();
        if (count.get() != 1 || !dispatcher.hasWork() || gate.pendingCount() != 0
                || Platform.pendingThreads() != 1) {
            throw new AssertionError("first worldgen turn was not bounded to one task");
        }
        while (count.get() < taskCount) {
            int before = count.get();
            Platform.runNextThread();
            if (count.get() != before || gate.pendingCount() != 1) {
                throw new AssertionError("deferred callback bypassed the executor boundary");
            }
            gate.drainOne();
            if (count.get() != before + 1) {
                throw new AssertionError("worldgen turn did not execute exactly one task");
            }
        }
        if (dispatcher.hasWork() || gate.pendingCount() != 0 || Platform.pendingThreads() != 0) {
            throw new AssertionError("worldgen backlog did not drain cleanly");
        }
        if (Platform.startedThreads() != taskCount - 1) {
            throw new AssertionError("worldgen backlog did not use one deferred turn per continuation");
        }

        Gate errorGate = new Gate();
        PriorityConsecutiveExecutor errorDispatcher =
                new PriorityConsecutiveExecutor(4, errorGate, "worldgen-dispatcher");
        AtomicInteger recoveredCount = new AtomicInteger();
        errorDispatcher.schedule(errorDispatcher.wrapRunnable(() -> { throw new ExpectedFailure(); }));
        errorDispatcher.schedule(errorDispatcher.wrapRunnable(recoveredCount::incrementAndGet));
        try {
            errorGate.drainOne();
            throw new AssertionError("expected task failure");
        } catch (ExpectedFailure expected) {
            // The patched finally path must leave the executor schedulable.
        }
        if (!errorDispatcher.hasWork()) {
            throw new AssertionError("exception path lost queued recovery work");
        }
        if (errorGate.pendingCount() != 0 || Platform.pendingThreads() != 1) {
            throw new AssertionError("exception recovery did not retain its deferred turn");
        }
        Platform.runNextThread();
        errorGate.drainOne();
        if (recoveredCount.get() != 1) {
            throw new AssertionError("exception path did not recover");
        }

        Gate closedGate = new Gate();
        PriorityConsecutiveExecutor closed =
                new PriorityConsecutiveExecutor(4, closedGate, "worldgen-dispatcher");
        closed.close();
        closed.schedule(closed.wrapRunnable(() -> { throw new AssertionError("closed task ran"); }));
        if (closed.hasWork()) {
            throw new AssertionError("closed dispatcher reports work");
        }

        AtomicInteger vanillaCount = new AtomicInteger();
        PriorityConsecutiveExecutor vanilla =
                new PriorityConsecutiveExecutor(4, Runnable::run, "dispatcher");
        vanilla.schedule(vanilla.wrapRunnable(vanillaCount::incrementAndGet));
        if (vanillaCount.get() != 1 || vanilla.hasWork()) {
            throw new AssertionError("vanilla dispatcher behavior changed");
        }

        AtomicInteger nullNameCount = new AtomicInteger();
        PriorityConsecutiveExecutor nullName =
                new PriorityConsecutiveExecutor(4, Runnable::run, null);
        nullName.schedule(nullName.wrapRunnable(nullNameCount::incrementAndGet));
        if (nullNameCount.get() != 1 || nullName.hasWork()) {
            throw new AssertionError("null-name dispatcher behavior changed");
        }
        System.out.println("WORLDGEN_PRIORITY_JVM_OK count=" + count.get());
    }

    private static final class ExpectedFailure extends RuntimeException {
    }
}
