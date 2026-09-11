import fastifyEnv from '@fastify/env';
import fastifyHelmet from '@fastify/helmet';
import fastifyMultipart, { type MultipartFile, type MultipartValue } from '@fastify/multipart';
import fastify, { type FastifyInstance } from 'fastify';

export async function buildFastifyApp(): Promise<FastifyInstance> {
  const app = fastify();

  await app.register(fastifyEnv, {
    schema: {
      type: 'object',
      properties: {
        host: {
          type: 'string',
          default: 'localhost',
        },
        bot_token: {
          type: 'string',
          minLength: 1,
        },
      },
      required: ['bot_token'],
    },
  });

  await app.register(fastifyHelmet);
  app.register(fastifyMultipart, { attachFieldsToBody: true });

  // Authorization check
  app.addHook('onRequest', async (req, res) => {
    if (req.headers.authorization !== req.server.config.bot_token) {
      return res.status(401).send({
        message: 'Credentials not valid.',
      });
    }
  });

  return app;
}

export async function parseMultiformBody(body: unknown): Promise<FormData> {
  const form = new FormData();

  if (typeof body !== 'object' || !body) return form;

  for (const objectValue of Object.values(body)) {
    const value = objectValue as MultipartFile | MultipartValue;

    if (value.type === 'file') {
      const buffer = await value.toBuffer();
      const bytes = new Uint8Array(buffer.byteLength);
      bytes.set(buffer);
      form.append(value.fieldname, new Blob([bytes]), value.filename);
    }
    if (value.type === 'field' && typeof value.value === 'string') {
      form.append(value.fieldname, value.value);
    }
  }

  return form;
}
