import { Module } from '@nestjs/common';
import { ChatModule } from '../chat/chat.module';
import { TelegramUpdate } from './telegram.update';
import { ResponderService } from './responder.service';
import { GroupGateService } from './group-gate.service';

@Module({
  imports: [ChatModule],
  providers: [TelegramUpdate, ResponderService, GroupGateService],
})
export class TelegramModule {}
