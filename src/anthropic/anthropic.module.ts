import { Global, Module } from '@nestjs/common';
import { AnthropicService } from './anthropic.service';

@Global()
@Module({
  providers: [AnthropicService],
  exports: [AnthropicService],
})
export class AnthropicModule {}
