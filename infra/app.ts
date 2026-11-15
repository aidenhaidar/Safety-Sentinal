import { App } from 'aws-cdk-lib';
import { SentinelStack } from './sentinel-stack';

const app = new App();
new SentinelStack(app, 'SafetySentinel', {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
  bedrockModelId: app.node.tryGetContext('bedrockModelId') ?? '',
  joinCode: app.node.tryGetContext('joinCode') ?? '',
  alertEmail: app.node.tryGetContext('alertEmail') ?? '',
});
