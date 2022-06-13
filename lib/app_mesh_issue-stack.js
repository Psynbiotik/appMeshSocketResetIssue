"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AppMeshIssueStack = void 0;
const aws_cdk_lib_1 = require("aws-cdk-lib");
const lambda = require("aws-cdk-lib/aws-lambda");
const appmesh = require("aws-cdk-lib/aws-appmesh");
const ec2 = require("aws-cdk-lib/aws-ec2");
const servicediscovery = require("aws-cdk-lib/aws-servicediscovery");
const cdk = require("aws-cdk-lib");
const ecs = require("aws-cdk-lib/aws-ecs");
const iam = require("aws-cdk-lib/aws-iam");
const aws_ecs_1 = require("aws-cdk-lib/aws-ecs");
const aws_logs_1 = require("aws-cdk-lib/aws-logs");
const logs = require("aws-cdk-lib/aws-logs");
// import * as sqs from 'aws-cdk-lib/aws-sqs';
class AppMeshIssueStack extends aws_cdk_lib_1.Stack {
    constructor(scope, id, props) {
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
        const namespace = new servicediscovery.PrivateDnsNamespace(this, "demoIssue-namespace", {
            vpc,
            name: "domain.local",
        });
        const serviceDiscoveryService = namespace.createService("Svc");
        const node = mesh.addVirtualNode("virtual-node", {
            serviceDiscovery: appmesh.ServiceDiscovery.cloudMap(serviceDiscoveryService),
            listeners: [
                appmesh.VirtualNodeListener.http({
                    port: port,
                    healthCheck: appmesh.HealthCheck.http({
                        healthyThreshold: 3,
                        interval: cdk.Duration.seconds(5),
                        path: "/health-check-path",
                        timeout: cdk.Duration.seconds(2),
                        unhealthyThreshold: 2,
                    }),
                }),
            ],
            accessLog: appmesh.AccessLog.fromFilePath("/dev/stdout"),
        });
        const virutalService = new appmesh.VirtualService(this, "virtual-service", {
            virtualServiceName: `my-service.default.svc.cluster.local`,
            virtualServiceProvider: appmesh.VirtualServiceProvider.virtualNode(node),
        });
        const containerImage = aws_ecs_1.ContainerImage.fromAsset("./fargate");
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
                    ignoredUID: 1337,
                    proxyIngressPort: 15000,
                    proxyEgressPort: 15001,
                },
            }),
            runtimePlatform: {
                cpuArchitecture: aws_ecs_1.CpuArchitecture.ARM64,
            },
        });
        const sidecarLogGroup = new logs.LogGroup(this, "SidecarLogGroup", {
            logGroupName: `/demoIssue/sidecar/${virutalService.virtualServiceName}`,
            retention: aws_logs_1.RetentionDays.ONE_MONTH,
        });
        const envoyContainerOptions = {
            image: ecs.ContainerImage.fromRegistry("public.ecr.aws/appmesh/aws-appmesh-envoy:v1.21.1.2-prod"),
            environment: {
                APPMESH_RESOURCE_ARN: node.virtualNodeArn,
                ENVOY_LOG_LEVEL: "info",
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
                interval: aws_cdk_lib_1.Duration.seconds(5),
                retries: 3,
                startPeriod: aws_cdk_lib_1.Duration.seconds(10),
                timeout: aws_cdk_lib_1.Duration.seconds(2),
            },
        };
        taskDefinition.addContainer("envoy", envoyContainerOptions);
        // Logging
        const logGroup = new logs.LogGroup(this, "DemoIssueLogGroup", {
            logGroupName: `/demoIssue/fargateService/${virutalService.virtualServiceName}`,
            retention: aws_logs_1.RetentionDays.ONE_MONTH,
        });
        // Service and config
        const mainContainerOptions = {
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
                interval: aws_cdk_lib_1.Duration.seconds(10),
                timeout: aws_cdk_lib_1.Duration.seconds(5),
                retries: 2,
                startPeriod: aws_cdk_lib_1.Duration.minutes(1),
            },
            logging: ecs.LogDriver.awsLogs({
                streamPrefix: "demoIssue",
                logGroup: logGroup,
            }),
        };
        taskDefinition.addContainer("demoIssue", mainContainerOptions);
        const securityGroup = new ec2.SecurityGroup(this, `DemoIssueSecurityGroup`, {
            vpc: vpc,
        });
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
            propagateTags: aws_ecs_1.PropagatedTagSource.TASK_DEFINITION,
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
        taskDefinition.taskRole.addToPrincipalPolicy(new iam.PolicyStatement({
            actions: ["lambda:InvokeFunction"],
            resources: [helloLambda.functionArn],
        }));
    }
}
exports.AppMeshIssueStack = AppMeshIssueStack;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiYXBwX21lc2hfaXNzdWUtc3RhY2suanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJhcHBfbWVzaF9pc3N1ZS1zdGFjay50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOzs7QUFBQSw2Q0FBMEQ7QUFFMUQsaURBQWlEO0FBQ2pELG1EQUFtRDtBQUNuRCwyQ0FBMkM7QUFFM0MscUVBQXFFO0FBQ3JFLG1DQUFtQztBQUNuQywyQ0FBMkM7QUFFM0MsMkNBQTJDO0FBQzNDLGlEQUk2QjtBQUM3QixtREFBcUQ7QUFDckQsNkNBQTZDO0FBRTdDLDhDQUE4QztBQUU5QyxNQUFhLGlCQUFrQixTQUFRLG1CQUFLO0lBQzFDLFlBQVksS0FBZ0IsRUFBRSxFQUFVLEVBQUUsS0FBa0I7UUFDMUQsS0FBSyxDQUFDLEtBQUssRUFBRSxFQUFFLEVBQUUsS0FBSyxDQUFDLENBQUM7UUFFeEIsTUFBTSxJQUFJLEdBQUcsSUFBSSxDQUFDO1FBRWxCLGlDQUFpQztRQUNqQyxNQUFNLFdBQVcsR0FBRyxJQUFJLE1BQU0sQ0FBQyxRQUFRLENBQUMsSUFBSSxFQUFFLGNBQWMsRUFBRTtZQUM1RCxPQUFPLEVBQUUsTUFBTSxDQUFDLE9BQU8sQ0FBQyxXQUFXO1lBQ25DLElBQUksRUFBRSxNQUFNLENBQUMsSUFBSSxDQUFDLFNBQVMsQ0FBQyxRQUFRLENBQUM7WUFDckMsT0FBTyxFQUFFLGVBQWU7U0FDekIsQ0FBQyxDQUFDO1FBRUgsTUFBTSxJQUFJLEdBQUcsSUFBSSxPQUFPLENBQUMsSUFBSSxDQUFDLElBQUksRUFBRSxTQUFTLEVBQUU7WUFDN0MsUUFBUSxFQUFFLGVBQWU7U0FDMUIsQ0FBQyxDQUFDO1FBRUgsTUFBTSxNQUFNLEdBQUcsSUFBSSxDQUFDLGdCQUFnQixDQUFDLFFBQVEsRUFBRTtZQUM3QyxTQUFTLEVBQUUsQ0FBQyxPQUFPLENBQUMscUJBQXFCLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxDQUFDO1NBQ3RELENBQUMsQ0FBQztRQUVILE1BQU0sR0FBRyxHQUFH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LENBQUMsYUFBYSxDQUFDO1NBQ2hDLENBQUMsQ0FBQztRQUVILGNBQWMsQ0FBQyx3QkFBd0IsQ0FBQztZQUN0QyxPQUFPLEVBQUUsdUJBQXVCO1NBQ2pDLENBQUMsQ0FBQztRQUVILGNBQWMsQ0FBQyxRQUFRLENBQUMsb0JBQW9CLENBQzFDLElBQUksR0FBRyxDQUFDLGVBQWUsQ0FBQztZQUN0QixPQUFPLEVBQUUsQ0FBQyx1QkFBdUIsQ0FBQztZQUNsQyxTQUFTLEVBQUUsQ0FBQyxXQUFXLENBQUMsV0FBVyxDQUFDO1NBQ3JDLENBQUMsQ0FDSCxDQUFDO0lBQ0osQ0FBQztDQUNGO0FBMUxELDhDQTBMQyIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCB7IFN0YWNrLCBTdGFja1Byb3BzLCBEdXJhdGlvbiB9IGZyb20gXCJhd3MtY2RrLWxpYlwiO1xuaW1wb3J0IHsgQ29uc3RydWN0IH0gZnJvbSBcImNvbnN0cnVjdHNcIjtcbmltcG9ydCAqIGFzIGxhbWJkYSBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWxhbWJkYVwiO1xuaW1wb3J0ICogYXMgYXBwbWVzaCBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWFwcG1lc2hcIjtcbmltcG9ydCAqIGFzIGVjMiBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWVjMlwiO1xuaW1wb3J0IHsgUG9ydCwgUHJvdG9jb2wsIFNlY3VyaXR5R3JvdXAgfSBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWVjMlwiO1xuaW1wb3J0ICogYXMgc2VydmljZWRpc2NvdmVyeSBmcm9tIFwiYXdzLWNkay1saWIvYXdzLXNlcnZpY2VkaXNjb3ZlcnlcIjtcbmltcG9ydCAqIGFzIGNkayBmcm9tIFwiYXdzLWNkay1saWJcIjtcbmltcG9ydCAqIGFzIGVjcyBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWVjc1wiO1xuaW1wb3J0ICogYXMgZWNzX3BhdHRlcm5zIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtZWNzLXBhdHRlcm5zXCI7XG5pbXBvcnQgKiBhcyBpYW0gZnJvbSBcImF3cy1jZGstbGliL2F3cy1pYW1cIjtcbmltcG9ydCB7XG4gIENvbnRhaW5lckltYWdlLFxuICBDcHVBcmNoaXRlY3R1cmUsXG4gIFByb3BhZ2F0ZWRUYWdTb3VyY2UsXG59IGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtZWNzXCI7XG5pbXBvcnQgeyBSZXRlbnRpb25EYXlzIH0gZnJvbSBcImF3cy1jZGstbGliL2F3cy1sb2dzXCI7XG5pbXBvcnQgKiBhcyBsb2dzIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtbG9nc1wiO1xuXG4vLyBpbXBvcnQgKiBhcyBzcXMgZnJvbSAnYXdzLWNkay1saWIvYXdzLXNxcyc7XG5cbmV4cG9ydCBjbGFzcyBBcHBNZXNoSXNzdWVTdGFjayBleHRlbmRzIFN0YWNrIHtcbiAgY29uc3RydWN0b3Ioc2NvcGU6IENvbnN0cnVjdCwgaWQ6IHN0cmluZywgcHJvcHM/OiBTdGFja1Byb3BzKSB7XG4gICAgc3VwZXIoc2NvcGUsIGlkLCBwcm9wcyk7XG5cbiAgICBjb25zdCBwb3J0ID0gODA4MDtcblxuICAgIC8vIGRlZmluZXMgYW4gQVdTIExhbWJkYSByZXNvdXJjZVxuICAgIGNvbnN0IGhlbGxvTGFtYmRhID0gbmV3IGxhbWJkYS5GdW5jdGlvbih0aGlzLCBcIkhlbGxvSGFuZGxlclwiLCB7XG4gICAgICBydW50aW1lOiBsYW1iZGEuUnVudGltZS5OT0RFSlNfMTRfWCxcbiAgICAgIGNvZGU6IGxhbWJkYS5Db2RlLmZyb21Bc3NldChcImxhbWJkYVwiKSxcbiAgICAgIGhhbmRsZXI6IFwiaGVsbG8uaGFuZGxlclwiLFxuICAgIH0pO1xuXG4gICAgY29uc3QgbWVzaCA9IG5ldyBhcHBtZXNoLk1lc2godGhpcywgXCJBcHBNZXNoXCIsIHtcbiAgICAgIG1lc2hOYW1lOiBcIm1lc2hEZW1vSXNzdWVcIixcbiAgICB9KTtcblxuICAgIGNvbnN0IHJvdXRlciA9IG1lc2guYWRkVmlydHVhbFJvdXRlcihcInJvdXRlclwiLCB7XG4gICAgICBsaXN0ZW5lcnM6IFthcHBtZXNoLlZpcnR1YWxSb3V0ZXJMaXN0ZW5lci5odHRwKHBvcnQpXSxcbiAgICB9KTtcblxuICAgIGNvbnN0IHZwYyA9IG5ldyBlYzIuVnBjKHRoaXMsIFwiZGVtb0lzc3VlVlBDXCIsIHtcbiAgICAgIG1heEF6czogMyxcbiAgICB9KTtcblxuICAgIGNvbnN0IGNsdXN0ZXIgPSBuZXcgZWNzLkNsdXN0ZXIodGhpcywgXCJEZW1vSXNzdWVDbHVzdGVyXCIsIHtcbiAgICAgIHZwYzogdnBjLFxuICAgIH0pO1xuXG4gICAgY29uc3QgbmFtZXNwYWNlID0gbmV3IHNlcnZpY2VkaXNjb3ZlcnkuUHJpdmF0ZURuc05hbWVzcGFjZShcbiAgICAgIHRoaXMsXG4gICAgICBcImRlbW9Jc3N1ZS1uYW1lc3BhY2VcIixcbiAgICAgIHtcbiAgICAgICAgdnBjLFxuICAgICAgICBuYW1lOiBcImRvbWFpbi5sb2NhbFwiLFxuICAgICAgfVxuICAgICk7XG4gICAgY29uc3Qgc2VydmljZURpc2NvdmVyeVNlcnZpY2UgPSBuYW1lc3BhY2UuY3JlYXRlU2VydmljZShcIlN2Y1wiKTtcblxuICAgIGNvbnN0IG5vZGUgPSBtZXNoLmFkZFZpcnR1YWxOb2RlKFwidmlydHVhbC1ub2RlXCIsIHtcbiAgICAgIHNlcnZpY2VEaXNjb3Zlcnk6IGFwcG1lc2guU2VydmljZURpc2NvdmVyeS5jbG91ZE1hcChcbiAgICAgICAgc2VydmljZURpc2NvdmVyeVNlcnZpY2VcbiAgICAgICksXG4gICAgICBsaXN0ZW5lcnM6IFtcbiAgICAgICAgYXBwbWVzaC5WaXJ0dWFsTm9kZUxpc3RlbmVyLmh0dHAoe1xuICAgICAgICAgIHBvcnQ6IHBvcnQsXG4gICAgICAgICAgaGVhbHRoQ2hlY2s6IGFwcG1lc2guSGVhbHRoQ2hlY2suaHR0cCh7XG4gICAgICAgICAgICBoZWFsdGh5VGhyZXNob2xkOiAzLFxuICAgICAgICAgICAgaW50ZXJ2YWw6IGNkay5EdXJhdGlvbi5zZWNvbmRzKDUpLCAvLyBtaW5pbXVtXG4gICAgICAgICAgICBwYXRoOiBcIi9oZWFsdGgtY2hlY2stcGF0aFwiLFxuICAgICAgICAgICAgdGltZW91dDogY2RrLkR1cmF0aW9uLnNlY29uZHMoMiksIC8vIG1pbmltdW1cbiAgICAgICAgICAgIHVuaGVhbHRoeVRocmVzaG9sZDogMixcbiAgICAgICAgICB9KSxcbiAgICAgICAgfSksXG4gICAgICBdLFxuICAgICAgYWNjZXNzTG9nOiBhcHBtZXNoLkFjY2Vzc0xvZy5mcm9tRmlsZVBhdGgoXCIvZGV2L3N0ZG91dFwiKSxcbiAgICB9KTtcblxuICAgIGNvbnN0IHZpcnV0YWxTZXJ2aWNlID0gbmV3IGFwcG1lc2guVmlydHVhbFNlcnZpY2UodGhpcywgXCJ2aXJ0dWFsLXNlcnZpY2VcIiwge1xuICAgICAgdmlydHVhbFNlcnZpY2VOYW1lOiBgbXktc2VydmljZS5kZWZhdWx0LnN2Yy5jbHVzdGVyLmxvY2FsYCwgLy8gb3B0aW9uYWxcbiAgICAgIHZpcnR1YWxTZXJ2aWNlUHJvdmlkZXI6IGFwcG1lc2guVmlydHVhbFNlcnZpY2VQcm92aWRlci52aXJ0dWFsTm9kZShub2RlKSxcbiAgICB9KTtcblxuICAgIGNvbnN0IGNvbnRhaW5lckltYWdlID0gQ29udGFpbmVySW1hZ2UuZnJvbUFzc2V0KFwiLi9mYXJnYXRlXCIpO1xuXG4gICAgY29uc3QgdGFza0RlZmluaXRpb24gPSBuZXcgZWNzLkZhcmdhdGVUYXNrRGVmaW5pdGlvbih0aGlzLCBcIlRhc2tEZWZcIiwge1xuICAgICAgY3B1OiAyNTYsXG4gICAgICBtZW1vcnlMaW1pdE1pQjogNTEyLFxuICAgICAgZmFtaWx5OiBcImRlbW9Jc3N1ZVwiLFxuICAgICAgcHJveHlDb25maWd1cmF0aW9uOiBlY3MuUHJveHlDb25maWd1cmF0aW9ucy5hcHBNZXNoUHJveHlDb25maWd1cmF0aW9uKHtcbiAgICAgICAgY29udGFpbmVyTmFtZTogXCJlbnZveVwiLFxuICAgICAgICBwcm9wZXJ0aWVzOiB7XG4gICAgICAgICAgYXBwUG9ydHM6IFtwb3J0XSxcbiAgICAgICAgICBlZ3Jlc3NJZ25vcmVkSVBzOiBbXCIxNjkuMjU0LjE3MC4yXCIsIFwiMTY5LjI1NC4xNjkuMjU0XCJdLFxuICAgICAgICAgIGVncmVzc0lnbm9yZWRQb3J0czogWzIyXSxcbiAgICAgICAgICBpZ25vcmVkVUlEOiAxMzM3LCAvLyBEb24ndCBsZXQgZW52b3kgZmlsdGVyIGl0c2VsZlxuICAgICAgICAgIHByb3h5SW5ncmVzc1BvcnQ6IDE1MDAwLCAvLyBUaGlzIGlzIHRvIHJlZGlyZWN0IHRyYWZmaWMgY29taW5nIGludG8gdGhlIGNvbnRhaW5lciB0aHJvdWdoIHRoZSBlbnZveSBwcm94eVxuICAgICAgICAgIHByb3h5RWdyZXNzUG9ydDogMTUwMDEsIC8vIFRoaXMgaXMgdG8gcmVkaXJlY3QgdHJhZmZpYyBnb2luZyBvdXQgb2YgdGhlIGNvbnRhaW5lciB0aHJvdWdoIHRoZSBlbnZveSBwcm94eVxuICAgICAgICB9LFxuICAgICAgfSksXG4gICAgICBydW50aW1lUGxhdGZvcm06IHtcbiAgICAgICAgY3B1QXJjaGl0ZWN0dXJlOiBDcHVBcmNoaXRlY3R1cmUuQVJNNjQsXG4gICAgICB9LFxuICAgIH0pO1xuXG4gICAgY29uc3Qgc2lkZWNhckxvZ0dyb3VwID0gbmV3IGxvZ3MuTG9nR3JvdXAodGhpcywgXCJTaWRlY2FyTG9nR3JvdXBcIiwge1xuICAgICAgbG9nR3JvdXBOYW1lOiBgL2RlbW9Jc3N1ZS9zaWRlY2FyLyR7dmlydXRhbFNlcnZpY2UudmlydHVhbFNlcnZpY2VOYW1lfWAsXG4gICAgICByZXRlbnRpb246IFJldGVudGlvbkRheXMuT05FX01PTlRILFxuICAgIH0pO1xuXG4gICAgY29uc3QgZW52b3lDb250YWluZXJPcHRpb25zOiBlY3MuQ29udGFpbmVyRGVmaW5pdGlvbk9wdGlvbnMgPSB7XG4gICAgICBpbWFnZTogZWNzLkNvbnRhaW5lckltYWdlLmZyb21SZWdpc3RyeShcbiAgICAgICAgXCJwdWJsaWMuZWNyLmF3cy9hcHBtZXNoL2F3cy1hcHBtZXNoLWVudm95OnYxLjIxLjEuMi1wcm9kXCJcbiAgICAgICksXG4gICAgICBlbnZpcm9ubWVudDoge1xuICAgICAgICBBUFBNRVNIX1JFU09VUkNFX0FSTjogbm9kZS52aXJ0dWFsTm9kZUFybixcbiAgICAgICAgRU5WT1lfTE9HX0xFVkVMOiBcImluZm9cIiwgLy8gVE9ETzogY2hhbmdlIHRvIGRlYnVnXG4gICAgICB9LFxuICAgICAgbG9nZ2luZzogZWNzLkxvZ0RyaXZlci5hd3NMb2dzKHtcbiAgICAgICAgc3RyZWFtUHJlZml4OiBcImVudm95XCIsXG4gICAgICAgIGxvZ0dyb3VwOiBzaWRlY2FyTG9nR3JvdXAsXG4gICAgICB9KSxcbiAgICAgIG1lbW9yeUxpbWl0TWlCOiA1MDAsXG4gICAgICB1c2VyOiBcIjEzMzdcIixcbiAgICAgIGhlYWx0aENoZWNrOiB7XG4gICAgICAgIGNvbW1hbmQ6IFtcbiAgICAgICAgICBcIkNNRC1TSEVMTFwiLFxuICAgICAgICAgIGBjdXJsIC1zIGh0dHA6Ly9sb2NhbGhvc3Q6OTkwMS9zZXJ2ZXJfaW5mbyB8IGdyZXAgc3RhdGUgfCBncmVwIC1xIExJVkVgLFxuICAgICAgICBdLFxuICAgICAgICBpbnRlcnZhbDogRHVyYXRpb24uc2Vjb25kcyg1KSxcbiAgICAgICAgcmV0cmllczogMyxcbiAgICAgICAgc3RhcnRQZXJpb2Q6IER1cmF0aW9uLnNlY29uZHMoMTApLFxuICAgICAgICB0aW1lb3V0OiBEdXJhdGlvbi5zZWNvbmRzKDIpLFxuICAgICAgfSxcbiAgICB9O1xuICAgIHRhc2tEZWZpbml0aW9uLmFkZENvbnRhaW5lcihcImVudm95XCIsIGVudm95Q29udGFpbmVyT3B0aW9ucyk7XG5cbiAgICAvLyBMb2dnaW5nXG4gICAgY29uc3QgbG9nR3JvdXAgPSBuZXcgbG9ncy5Mb2dHcm91cCh0aGlzLCBcIkRlbW9Jc3N1ZUxvZ0dyb3VwXCIsIHtcbiAgICAgIGxvZ0dyb3VwTmFtZTogYC9kZW1vSXNzdWUvZmFyZ2F0ZVNlcnZpY2UvJHt2aXJ1dGFsU2VydmljZS52aXJ0dWFsU2VydmljZU5hbWV9YCxcbiAgICAgIHJldGVudGlvbjogUmV0ZW50aW9uRGF5cy5PTkVfTU9OVEgsXG4gICAgfSk7XG5cbiAgICAvLyBTZXJ2aWNlIGFuZCBjb25maWdcbiAgICBjb25zdCBtYWluQ29udGFpbmVyT3B0aW9uczogZWNzLkNvbnRhaW5lckRlZmluaXRpb25PcHRpb25zID0ge1xuICAgICAgaW1hZ2U6IGNvbnRhaW5lckltYWdlLFxuICAgICAgcG9ydE1hcHBpbmdzOiBbeyBjb250YWluZXJQb3J0OiBwb3J0IH1dLFxuICAgICAgZW52aXJvbm1lbnQ6IHtcbiAgICAgICAgTEFNQkRBX0FSTjogaGVsbG9MYW1iZGEuZnVuY3Rpb25Bcm4sXG4gICAgICB9LFxuICAgICAgaGVhbHRoQ2hlY2s6IHtcbiAgICAgICAgY29tbWFuZDogW1xuICAgICAgICAgIFwiQ01ELVNIRUxMXCIsXG4gICAgICAgICAgXCJjdXJsIC1mIGh0dHA6Ly9sb2NhbGhvc3Q6XCIgKyBwb3J0ICsgXCIvaGVhbHRoIHx8IGV4aXQgMVwiLFxuICAgICAgICBdLFxuICAgICAgICBpbnRlcnZhbDogRHVyYXRpb24uc2Vjb25kcygxMCksXG4gICAgICAgIHRpbWVvdXQ6IER1cmF0aW9uLnNlY29uZHMoNSksXG4gICAgICAgIHJldHJpZXM6IDIsXG4gICAgICAgIHN0YXJ0UGVyaW9kOiBEdXJhdGlvbi5taW51dGVzKDEpLFxuICAgICAgfSxcbiAgICAgIGxvZ2dpbmc6IGVjcy5Mb2dEcml2ZXIuYXdzTG9ncyh7XG4gICAgICAgIHN0cmVhbVByZWZpeDogXCJkZW1vSXNzdWVcIixcbiAgICAgICAgbG9nR3JvdXA6IGxvZ0dyb3VwLFxuICAgICAgfSksXG4gICAgfTtcbiAgICB0YXNrRGVmaW5pdGlvbi5hZGRDb250YWluZXIoXCJkZW1vSXNzdWVcIiwgbWFpbkNvbnRhaW5lck9wdGlvbnMpO1xuXG4gICAgY29uc3Qgc2VjdXJpdHlHcm91cCA9IG5ldyBlYzIuU2VjdXJpdHlHcm91cChcbiAgICAgIHRoaXMsXG4gICAgICBgRGVtb0lzc3VlU2VjdXJpdHlHcm91cGAsXG4gICAgICB7XG4gICAgICAgIHZwYzogdnBjLFxuICAgICAgfVxuICAgICk7XG5cbiAgICBjb25zdCBmYXJnYXRlU2VydmljZSA9IG5ldyBlY3MuRmFyZ2F0ZVNlcnZpY2UodGhpcywgXCJGYXJnYXRlU2VydmljZVwiLCB7XG4gICAgICBjbHVzdGVyOiBjbHVzdGVyLFxuICAgICAgdGFza0RlZmluaXRpb246IHRhc2tEZWZpbml0aW9uLFxuICAgICAgZGVwbG95bWVudENvbnRyb2xsZXI6IHtcbiAgICAgICAgdHlwZTogZWNzLkRlcGxveW1lbnRDb250cm9sbGVyVHlwZS5FQ1MsXG4gICAgICB9LFxuICAgICAgY2lyY3VpdEJyZWFrZXI6IHtcbiAgICAgICAgcm9sbGJhY2s6IHRydWUsXG4gICAgICB9LFxuICAgICAgbWluSGVhbHRoeVBlcmNlbnQ6IDEwMCxcbiAgICAgIGRlc2lyZWRDb3VudDogMSxcbiAgICAgIHByb3BhZ2F0ZVRhZ3M6IFByb3BhZ2F0ZWRUYWdTb3VyY2UuVEFTS19ERUZJTklUSU9OLFxuICAgICAgc2VydmljZU5hbWU6IGBkZW1vSXNzdWVgLFxuICAgICAgYXNzaWduUHVibGljSXA6IGZhbHNlLFxuICAgICAgdnBjU3VibmV0czoge1xuICAgICAgICBzdWJuZXRzOiB2cGMucHJpdmF0ZVN1Ym5ldHMsXG4gICAgICB9LFxuICAgICAgc2VjdXJpdHlHcm91cHM6IFtzZWN1cml0eUdyb3VwXSxcbiAgICB9KTtcblxuICAgIGZhcmdhdGVTZXJ2aWNlLmFzc29jaWF0ZUNsb3VkTWFwU2VydmljZSh7XG4gICAgICBzZXJ2aWNlOiBzZXJ2aWNlRGlzY292ZXJ5U2VydmljZSxcbiAgICB9KTtcblxuICAgIHRhc2tEZWZpbml0aW9uLnRhc2tSb2xlLmFkZFRvUHJpbmNpcGFsUG9saWN5KFxuICAgICAgbmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xuICAgICAgICBhY3Rpb25zOiBbXCJsYW1iZGE6SW52b2tlRnVuY3Rpb25cIl0sXG4gICAgICAgIHJlc291cmNlczogW2hlbGxvTGFtYmRhLmZ1bmN0aW9uQXJuXSxcbiAgICAgIH0pXG4gICAgKTtcbiAgfVxufVxuIl19