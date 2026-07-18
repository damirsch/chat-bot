import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TelegrafModule } from 'nestjs-telegraf';
import { PrismaModule } from './prisma/prisma.module';
import { AnthropicModule } from './anthropic/anthropic.module';
import { ChatModule } from './chat/chat.module';
import { TelegramModule } from './telegram/telegram.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    TelegrafModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const token = config.get<string>('TELEGRAM_BOT_TOKEN');
        if (!token) {
          throw new Error('TELEGRAM_BOT_TOKEN is not set');
        }
        return {
          token,
          include: [TelegramModule],
        };
      },
    }),
    PrismaModule,
    AnthropicModule,
    ChatModule,
    TelegramModule,
  ],
})
export class AppModule {}
