import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import * as cookieParser from 'cookie-parser';
import * as express from 'express';
import helmet from 'helmet';

// Ensure BigInt values serialize to JSON (Prisma returns BigInt for BigInt columns)
(BigInt.prototype as any).toJSON = function () {
  return this.toString();
};

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // Security
  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(cookieParser());

  // 信任一层反向代理（Nginx）的 X-Forwarded-For：取到真实客户端 IP 而非代理 IP。
  // 登录/注册的 IP 限流依赖 req.ip，不设这行的话所有用户会共享同一个代理 IP，导致自己和别人互相误伤
  // 注意：`set` 是 Express 应用的方法，Nest 类型不认 → 从底层 HTTP 适配器拿实例再设
  app.getHttpAdapter().getInstance().set('trust proxy', 1);

  // 微信支付通知是 XML，默认 body 解析器不处理它 → 以原始文本接收，验签在 PaymentService 内完成
  app.use(express.text({ type: ['application/xml', 'text/xml'] }));

  // CORS
  app.enableCors({
    origin: [
      process.env.FRONTEND_URL || 'http://localhost:3000',
      process.env.ADMIN_URL || 'http://localhost:3002',
    ],
    credentials: true,
  });

  // Global prefix
  app.setGlobalPrefix('api');

  // Global pipes
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  // Global filters
  app.useGlobalFilters(new HttpExceptionFilter());

  // Swagger
  const config = new DocumentBuilder()
    .setTitle('Node Shop API')
    .setDescription('VPN Node Selling Platform API')
    .setVersion('1.0')
    .addBearerAuth()
    .build();
  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('docs', app, document);

  const port = process.env.BACKEND_PORT || 3001;
  await app.listen(port);
  console.log(`🚀 Backend running on http://localhost:${port}`);
  console.log(`📚 API docs at http://localhost:${port}/docs`);
}
bootstrap();
