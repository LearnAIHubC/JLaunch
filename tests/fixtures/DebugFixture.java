public final class DebugFixture {
    private DebugFixture() {
    }

    public static void main(String[] arguments) throws InterruptedException {
        Runtime.getRuntime().addShutdownHook(new Thread(() -> System.out.println("fixture stopped")));
        System.out.println("fixture ready");
        while (true) {
            Thread.sleep(1_000L);
        }
    }
}
