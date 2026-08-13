import { Module } from '@nestjs/common';

import { LiveKitWebhookController } from './livekit-webhook.controller';
import { LiveKitService } from './livekit.service';

@Module({
  controllers: [LiveKitWebhookController],
  providers: [LiveKitService],
  exports: [LiveKitService],
})
export class LiveKitModule {}
