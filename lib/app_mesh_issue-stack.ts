import { Stack, StackProps, Duration, RemovalPolicy } from "aws-cdk-lib";
import { Construct } from "constructs";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as appmesh from "aws-cdk-lib/aws-appmesh";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import { Port, Protocol, SecurityGroup } from "aws-cdk-lib/aws-ec2";
import * as servicediscovery from "aws-cdk-lib/aws-servicediscovery";
import * as cdk from "aws-cdk-lib";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as ecs_patterns from "aws-cdk-lib/aws-ecs-patterns";
import * as iam from "aws-cdk-lib/aws-iam";
import {
  ContainerImage,
  CpuArchitecture,
  PropagatedTagSource,
} from "aws-cdk-lib/aws-ecs";
import { RetentionDays } from "aws-cdk-lib/aws-logs";
import * as logs from "aws-cdk-lib/aws-logs";

// import * as sqs from 'aws-cdk-lib/aws-sqs';

export class AppMeshIssueStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const port = 8080;

    // defines an AWS Lambda resource
    const helloLambda = new lambda.Function(this, "HelloHandler", {
      runtime: lambda.Runtime.NODEJS_14_X,
      code: lambda.Code.fromAsset("lambda"),
      handler: "hello.handler",
    });

    const mesh = new appmesh.Mesh(this, "AppMesh", {
      meshName: "meshDemoIssue",
    });

    const router = mesh.addVirtualRouter("router", {
      listeners: [appmesh.VirtualRouterListener.http(port)],
    });

    const vpc = new ec2.Vpc(this, "demoIssueVPC", {
      maxAzs: 3,
    });

    const cluster = new ecs.Cluster(this, "DemoIssueCluster", {
      vpc: vpc,
    });

    const namespace = new servicediscovery.PrivateDnsNamespace(
      this,
      "demoIssue-namespace",
      {
        vpc,
        name: "domain.local",
      }
    );
    const serviceDiscoveryService = namespace.createService("Svc");

    const node = mesh.addVirtualNode("virtual-node", {
      serviceDiscovery: appmesh.ServiceDiscovery.cloudMap(
        serviceDiscoveryService
      ),
      listeners: [
        appmesh.VirtualNodeListener.http({
          port: port,
          healthCheck: appmesh.HealthCheck.http({
            healthyThreshold: 3,
            interval: cdk.Duration.seconds(5), // minimum
            path: "/health-check-path",
            timeout: cdk.Duration.seconds(2), // minimum
            unhealthyThreshold: 2,
          }),
        }),
      ],
      accessLog: appmesh.AccessLog.fromFilePath("/dev/stdout"),
    });

    const virutalService = new appmesh.VirtualService(this, "virtual-service", {
      virtualServiceName: `my-service.default.svc.cluster.local`, // optional
      virtualServiceProvider: appmesh.VirtualServiceProvider.virtualNode(node),
    });

    const containerImage = ContainerImage.fromAsset("./fargate");

    const taskDefinition = new ecs.FargateTaskDefinition(this, "TaskDef", {
      cpu: 256,
      memoryLimitMiB: 512,
      family: "demoIssue",
      proxyConfiguration: ecs.ProxyConfigurations.appMeshProxyConfiguration({
        containerName: "envoy",
        properties: {
          appPorts: [port],
          egressIgnoredIPs: ["169.254.170.2", "169.254.169.254"],
          egressIgnoredPorts: [22],
          ignoredUID: 1337, // Don't let envoy filter itself
          proxyIngressPort: 15000, // This is to redirect traffic coming into the container through the envoy proxy
          proxyEgressPort: 15001, // This is to redirect traffic going out of the container through the envoy proxy
        },
      }),
      runtimePlatform: {
        cpuArchitecture: CpuArchitecture.ARM64,
      },
    });

    const sidecarLogGroup = new logs.LogGroup(this, "SidecarLogGroup", {
      logGroupName: `/demoIssue/sidecar/${virutalService.virtualServiceName}`,
      retention: RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const envoyContainerOptions: ecs.ContainerDefinitionOptions = {
      image: ecs.ContainerImage.fromRegistry(
        "public.ecr.aws/appmesh/aws-appmesh-envoy:v1.22.0.0-prod"
      ),
      environment: {
        APPMESH_RESOURCE_ARN: node.virtualNodeArn,
        ENVOY_LOG_LEVEL: "debug",
      },
      logging: ecs.LogDriver.awsLogs({
        streamPrefix: "envoy",
        logGroup: sidecarLogGroup,
      }),
      memoryLimitMiB: 500,
      user: "1337",
      healthCheck: {
        command: [
          "CMD-SHELL",
          `curl -s http://localhost:9901/server_info | grep state | grep -q LIVE`,
        ],
        interval: Duration.seconds(5),
        retries: 3,
        startPeriod: Duration.seconds(10),
        timeout: Duration.seconds(2),
      },
    };
    taskDefinition.addContainer("envoy", envoyContainerOptions);

    // Logging
    const logGroup = new logs.LogGroup(this, "DemoIssueLogGroup", {
      logGroupName: `/demoIssue/fargateService/${virutalService.virtualServiceName}`,
      retention: RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // Service and config
    const mainContainerOptions: ecs.ContainerDefinitionOptions = {
      image: containerImage,
      portMappings: [{ containerPort: port }],
      environment: {
        LAMBDA_ARN: helloLambda.functionArn,
      },
      healthCheck: {
        command: [
          "CMD-SHELL",
          "curl -f http://localhost:" + port + "/health || exit 1",
        ],
        interval: Duration.seconds(10),
        timeout: Duration.seconds(5),
        retries: 2,
        startPeriod: Duration.minutes(1),
      },
      logging: ecs.LogDriver.awsLogs({
        streamPrefix: "demoIssue",
        logGroup: logGroup,
      }),
    };
    taskDefinition.addContainer("demoIssue", mainContainerOptions);

    const securityGroup = new ec2.SecurityGroup(
      this,
      `DemoIssueSecurityGroup`,
      {
        vpc: vpc,
      }
    );

    const fargateService = new ecs.FargateService(this, "FargateService", {
      cluster: cluster,
      taskDefinition: taskDefinition,
      deploymentController: {
        type: ecs.DeploymentControllerType.ECS,
      },
      circuitBreaker: {
        rollback: true,
      },
      minHealthyPercent: 100,
      desiredCount: 1,
      propagateTags: PropagatedTagSource.TASK_DEFINITION,
      serviceName: `demoIssue`,
      assignPublicIp: false,
      vpcSubnets: {
        subnets: vpc.privateSubnets,
      },
      securityGroups: [securityGroup],
    });

    fargateService.associateCloudMapService({
      service: serviceDiscoveryService,
    });

    taskDefinition.taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ["lambda:InvokeFunction"],
        resources: [helloLambda.functionArn],
      })
    );
  }
}
