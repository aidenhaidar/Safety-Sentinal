import { join } from 'node:path';
import { CfnOutput, Duration, RemovalPolicy, Stack, StackProps } from 'aws-cdk-lib';
import { WebSocketApi, WebSocketStage } from 'aws-cdk-lib/aws-apigatewayv2';
import { WebSocketLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import { S3BucketOrigin } from 'aws-cdk-lib/aws-cloudfront-origins';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kinesis from 'aws-cdk-lib/aws-kinesis';
import { Architecture, Runtime, StartingPosition } from 'aws-cdk-lib/aws-lambda';
import { KinesisEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import { NodejsFunction, NodejsFunctionProps } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subs from 'aws-cdk-lib/aws-sns-subscriptions';
import { Construct } from 'constructs';

interface Props extends StackProps { bedrockModelId: string; joinCode: string; alertEmail: string }
const root = join(__dirname, '..');

/**
 * Phones -> API Gateway (WebSocket) -> ingest Lambda -> Kinesis -> analyzer Lambda
 *   (Rekognition + YAMNet + Bedrock agents) -> EventBridge -> responder Lambda and SNS.
 */
export class SentinelStack extends Stack {
  constructor(scope: Construct, id: string, props: Props) {
    super(scope, id, props);

    // ---- State ----
    const table = new dynamodb.Table(this, 'State', {
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST, timeToLiveAttribute: 'ttl', removalPolicy: RemovalPolicy.DESTROY,
    });

    // ---- Media stream: one record per camera frame or audio clip, ordered per node ----
    const stream = new kinesis.Stream(this, 'Media', { streamMode: kinesis.StreamMode.PROVISIONED, shardCount: 2, retentionPeriod: Duration.hours(24), removalPolicy: RemovalPolicy.DESTROY });

    // ---- Threat events ----
    const bus = new events.EventBus(this, 'Bus', { eventBusName: `${this.stackName}-threats` });
    const alerts = new sns.Topic(this, 'Alerts', { displayName: 'Safety Sentinel alerts' });
    if (props.alertEmail) alerts.addSubscription(new subs.EmailSubscription(props.alertEmail));

    const fn = (name: string, extra: Partial<NodejsFunctionProps> = {}) => new NodejsFunction(this, name, {
      entry: join(root, 'src', 'lambda', `${name.toLowerCase()}.ts`), handler: 'handler',
      runtime: Runtime.NODEJS_22_X, architecture: Architecture.X86_64, memorySize: 256, timeout: Duration.seconds(15),
      depsLockFilePath: join(root, 'package-lock.json'), logRetention: logs.RetentionDays.ONE_WEEK,
      ...extra,
      environment: { TABLE: table.tableName, STREAM: stream.streamName, BUS: bus.eventBusName, JOIN_CODE: props.joinCode, ...extra.environment },
      bundling: { minify: false, sourceMap: false, ...extra.bundling },
    });

    // ---- WebSocket ingest ----
    const ingest = fn('Ingest');
    const api = new WebSocketApi(this, 'Ws', {
      apiName: `${this.stackName}-ws`, routeSelectionExpression: '$request.body.action',
      connectRouteOptions: { integration: new WebSocketLambdaIntegration('ConnectInt', ingest) },
      disconnectRouteOptions: { integration: new WebSocketLambdaIntegration('DisconnectInt', ingest) },
      defaultRouteOptions: { integration: new WebSocketLambdaIntegration('DefaultInt', ingest) },
    });
    const stage = new WebSocketStage(this, 'Prod', { webSocketApi: api, stageName: 'prod', autoDeploy: true, throttle: { rateLimit: 200, burstLimit: 400 } });
    const manageConnections = new iam.PolicyStatement({ actions: ['execute-api:ManageConnections'], resources: [`arn:aws:execute-api:${this.region}:${this.account}:*/*/POST/@connections/*`] });

    // ---- Analyzer: perception + agents + fusion ----
    const analyzer = fn('Analyzer', {
      memorySize: 1536, timeout: Duration.seconds(45),
      environment: { WS_ENDPOINT: stage.callbackUrl, BEDROCK_MODEL_ID: props.bedrockModelId },
      bundling: {
        nodeModules: ['onnxruntime-node'], environment: { ONNXRUNTIME_NODE_INSTALL: 'skip', ONNXRUNTIME_NODE_INSTALL_CUDA: 'skip' },
        commandHooks: {
          beforeBundling: () => [], beforeInstall: () => [],
          afterBundling: (inputDir, outputDir) => [`node "${join(inputDir, 'scripts', 'prune-ort.mjs')}" "${inputDir}" "${outputDir}"`],
        },
      },
    });
    analyzer.addEventSource(new KinesisEventSource(stream, {
      startingPosition: StartingPosition.LATEST, batchSize: 25, parallelizationFactor: 10,
      retryAttempts: 1, maxRecordAge: Duration.seconds(60), // stale media is worthless; drop it rather than fall behind
    }));
    analyzer.addToRolePolicy(new iam.PolicyStatement({ actions: ['rekognition:DetectLabels', 'rekognition:DetectModerationLabels'], resources: ['*'] }));
    analyzer.addToRolePolicy(new iam.PolicyStatement({ actions: ['bedrock-mantle:CreateInference', 'bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'], resources: ['*'] }));

    // ---- Responder: the action algorithm ----
    const responder = fn('Responder', { environment: { WS_ENDPOINT: stage.callbackUrl } });
    // Direct-to-phone SMS only: allow Publish, but not to any topic.
    responder.addToRolePolicy(new iam.PolicyStatement({ actions: ['sns:Publish'], resources: ['*'] }));
    responder.addToRolePolicy(new iam.PolicyStatement({ effect: iam.Effect.DENY, actions: ['sns:Publish'], resources: ['arn:aws:sns:*:*:*'] }));

    for (const f of [ingest, analyzer, responder]) { table.grantReadWriteData(f); f.addToRolePolicy(manageConnections); }
    stream.grantWrite(ingest);
    bus.grantPutEventsTo(analyzer);

    // ---- EventBridge rules: on detection -> Lambda (custom alerts), SNS (text/email), log (audit trail) ----
    const detected = { source: ['safety.sentinel'], detailType: ['ThreatDetected'] };
    new events.Rule(this, 'ToResponder', { eventBus: bus, eventPattern: detected, targets: [new targets.LambdaFunction(responder, { retryAttempts: 2 })] });
    new events.Rule(this, 'ToSns', {
      eventBus: bus, eventPattern: { ...detected, detail: { level: ['HIGH', 'CRITICAL'] } },
      targets: [new targets.SnsTopic(alerts, { message: events.RuleTargetInput.fromEventPath('$.detail.text') })],
    });
    new events.Rule(this, 'ToAudit', {
      eventBus: bus, eventPattern: detected,
      targets: [new targets.CloudWatchLogGroup(new logs.LogGroup(this, 'Audit', { retention: logs.RetentionDays.ONE_MONTH, removalPolicy: RemovalPolicy.DESTROY }))],
    });

    // ---- Web app: S3 + CloudFront (HTTPS is required for camera/microphone access on phones) ----
    const site = new s3.Bucket(this, 'Site', { blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL, enforceSSL: true, removalPolicy: RemovalPolicy.DESTROY, autoDeleteObjects: true });
    const cdn = new cloudfront.Distribution(this, 'Cdn', {
      defaultRootObject: 'index.html',
      defaultBehavior: { origin: S3BucketOrigin.withOriginAccessControl(site), viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS },
    });
    new s3deploy.BucketDeployment(this, 'DeploySite', {
      destinationBucket: site, distribution: cdn,
      sources: [s3deploy.Source.asset(join(root, 'web')), s3deploy.Source.data('config.js', `window.SENTINEL_CONFIG = ${JSON.stringify({ wsUrl: '__WS__', joinCodeRequired: !!props.joinCode })};`.replace('__WS__', stage.url))],
    });

    new CfnOutput(this, 'DashboardUrl', { value: `https://${cdn.distributionDomainName}/` });
    new CfnOutput(this, 'PhoneNodeUrl', { value: `https://${cdn.distributionDomainName}/node.html` });
    new CfnOutput(this, 'WebSocketUrl', { value: stage.url });
    new CfnOutput(this, 'AlertsTopicArn', { value: alerts.topicArn });
  }
}
