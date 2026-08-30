import { pipelineService } from '../services/pipeline.service.ts';
import { outboxService } from '../services/outbox.service.ts';

async function runTests() {
  console.log("Running pipeline E2E stub test...");
  try {
    await pipelineService.processInboundMessage({
      fromEmail: "test@example.com",
      fromName: "John Doe",
      subject: "Test email",
      textBody: "I have a technical question about the latency. How fast is it?",
      providerMessageId: "msg_123",
      threadId: "thread_123",
      orgId: "org_1"
    });
    console.log("Pipeline dry-run executed successfully.");
  } catch(e) {
    console.error("Pipeline test failed:", e);
  }
}
runTests();
