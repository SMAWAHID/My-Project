import { Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  EC2Client,
  DescribeInstancesCommand,
  DescribeInstanceStatusCommand,
  DescribeSecurityGroupsCommand,
  DescribeVolumesCommand,
} from "@aws-sdk/client-ec2";
import {
  ECSClient,
  ListClustersCommand,
  ListServicesCommand,
  DescribeServicesCommand,
  ListTasksCommand,
  DescribeTasksCommand,
} from "@aws-sdk/client-ecs";
import {
  ElasticLoadBalancingV2Client,
  DescribeLoadBalancersCommand,
  DescribeTargetGroupsCommand,
  DescribeTargetHealthCommand,
} from "@aws-sdk/client-elastic-load-balancing-v2"; // correct package name
import {
  RDSClient,
  DescribeDBInstancesCommand,
  DescribeDBClustersCommand,
} from "@aws-sdk/client-rds";

// ─── AWS client factory ───────────────────────────────────────────────────────
function awsConfig() {
  return {
    region: process.env.AWS_REGION || "us-east-1",
    credentials: process.env.AWS_ACCESS_KEY_ID ? {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
      sessionToken: process.env.AWS_SESSION_TOKEN,
    } : undefined,
  };
}

function notConfigured(tool: string) {
  return {
    error: "AWS credentials not configured",
    tool,
    setup: "Set AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION in your .env file",
    iam_permissions_needed: [
      "ec2:DescribeInstances", "ec2:DescribeInstanceStatus",
      "ecs:ListClusters", "ecs:ListServices", "ecs:DescribeServices",
      "elasticloadbalancing:DescribeLoadBalancers",
      "rds:DescribeDBInstances"
    ],
    timestamp: new Date().toISOString(),
  };
}

// ─── Tool definitions ─────────────────────────────────────────────────────────
export const awsTools: Tool[] = [
  {
    name: "list_ec2_instances",
    description: "List all EC2 instances in your AWS account with their state, type, IP, and tags. READ-ONLY.",
    inputSchema: {
      type: "object",
      properties: {
        state: {
          type: "string",
          enum: ["running", "stopped", "terminated", "all"],
          default: "all",
          description: "Filter by instance state",
        },
        region: { type: "string", description: "AWS region (defaults to AWS_REGION env var)" },
        tag_filter: { type: "string", description: "Filter by Name tag (e.g. 'prod-api')" },
      },
    },
  },
  {
    name: "get_ec2_instance_health",
    description: "Get detailed health status and system checks for EC2 instances. READ-ONLY.",
    inputSchema: {
      type: "object",
      properties: {
        instance_ids: {
          type: "array",
          items: { type: "string" },
          description: "List of instance IDs (e.g. ['i-1234567890abcdef0']). Leave empty for all.",
        },
        region: { type: "string" },
      },
    },
  },
  {
    name: "list_ecs_services",
    description: "List ECS clusters and services with their running/desired task counts. READ-ONLY.",
    inputSchema: {
      type: "object",
      properties: {
        cluster: { type: "string", description: "ECS cluster name or ARN (optional, lists all clusters if omitted)" },
        region: { type: "string" },
      },
    },
  },
  {
    name: "list_rds_instances",
    description: "List RDS database instances and Aurora clusters with status and endpoint info. READ-ONLY.",
    inputSchema: {
      type: "object",
      properties: {
        region: { type: "string" },
      },
    },
  },
  {
    name: "list_load_balancers",
    description: "List Application and Network Load Balancers with target group health. READ-ONLY.",
    inputSchema: {
      type: "object",
      properties: {
        region: { type: "string" },
      },
    },
  },
];

// ─── Tool handlers ────────────────────────────────────────────────────────────
export const awsToolHandlers: Record<string, (args: unknown) => Promise<unknown>> = {

  list_ec2_instances: async (args: unknown) => {
    if (!process.env.AWS_ACCESS_KEY_ID) return notConfigured("list_ec2_instances");

    const { state = "all", region, tag_filter } = args as {
      state?: string; region?: string; tag_filter?: string;
    };

    try {
      const client = new EC2Client({ ...awsConfig(), region: region || awsConfig().region });

      const filters: Array<{ Name: string; Values: string[] }> = [];
      if (state !== "all") filters.push({ Name: "instance-state-name", Values: [state] });
      if (tag_filter) filters.push({ Name: "tag:Name", Values: [`*${tag_filter}*`] });

      const response = await client.send(new DescribeInstancesCommand({
        Filters: filters.length > 0 ? filters : undefined,
        MaxResults: 100,
      }));

      const instances = [];
      for (const reservation of response.Reservations || []) {
        for (const inst of reservation.Instances || []) {
          const nameTag = inst.Tags?.find(t => t.Key === "Name")?.Value || "";
          const envTag = inst.Tags?.find(t => t.Key === "Environment" || t.Key === "Env")?.Value || "";
          instances.push({
            instance_id: inst.InstanceId,
            name: nameTag,
            environment: envTag,
            state: inst.State?.Name,
            type: inst.InstanceType,
            public_ip: inst.PublicIpAddress || null,
            private_ip: inst.PrivateIpAddress || null,
            public_dns: inst.PublicDnsName || null,
            launched: inst.LaunchTime?.toISOString(),
            availability_zone: inst.Placement?.AvailabilityZone,
            vpc_id: inst.VpcId,
            ami: inst.ImageId,
            key_name: inst.KeyName,
            tags: Object.fromEntries((inst.Tags || []).map(t => [t.Key, t.Value])),
          });
        }
      }

      const running = instances.filter(i => i.state === "running");
      const stopped = instances.filter(i => i.state === "stopped");

      return {
        total: instances.length,
        running: running.length,
        stopped: stopped.length,
        region: region || awsConfig().region,
        instances,
        alerts: stopped.length > 0 ? [`${stopped.length} instance(s) are stopped`] : [],
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return { error: msg, hint: "Check AWS_REGION and IAM permissions (ec2:DescribeInstances)", timestamp: new Date().toISOString() };
    }
  },

  get_ec2_instance_health: async (args: unknown) => {
    if (!process.env.AWS_ACCESS_KEY_ID) return notConfigured("get_ec2_instance_health");

    const { instance_ids = [], region } = args as { instance_ids?: string[]; region?: string };

    try {
      const client = new EC2Client({ ...awsConfig(), region: region || awsConfig().region });

      const response = await client.send(new DescribeInstanceStatusCommand({
        InstanceIds: instance_ids.length > 0 ? instance_ids : undefined,
        IncludeAllInstances: true,
        MaxResults: 100,
      }));

      const statuses = (response.InstanceStatuses || []).map(s => ({
        instance_id: s.InstanceId,
        state: s.InstanceState?.Name,
        availability_zone: s.AvailabilityZone,
        system_status: s.SystemStatus?.Status,
        system_checks: s.SystemStatus?.Details?.map(d => ({
          name: d.Name,
          status: d.Status,
          impaired_since: d.ImpairedSince?.toISOString(),
        })),
        instance_status: s.InstanceStatus?.Status,
        instance_checks: s.InstanceStatus?.Details?.map(d => ({
          name: d.Name,
          status: d.Status,
          impaired_since: d.ImpairedSince?.toISOString(),
        })),
      }));

      const unhealthy = statuses.filter(s =>
        s.system_status !== "ok" || s.instance_status !== "ok"
      );

      return {
        total_checked: statuses.length,
        unhealthy_count: unhealthy.length,
        statuses,
        unhealthy_instances: unhealthy,
        alerts: unhealthy.map(i => `Instance ${i.instance_id} has status issues: system=${i.system_status}, instance=${i.instance_status}`),
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return { error: msg, timestamp: new Date().toISOString() };
    }
  },

  list_ecs_services: async (args: unknown) => {
    if (!process.env.AWS_ACCESS_KEY_ID) return notConfigured("list_ecs_services");

    const { cluster, region } = args as { cluster?: string; region?: string };

    try {
      const client = new ECSClient({ ...awsConfig(), region: region || awsConfig().region });

      // Get clusters
      let clusterArns: string[] = [];
      if (cluster) {
        clusterArns = [cluster];
      } else {
        const clustersResp = await client.send(new ListClustersCommand({}));
        clusterArns = clustersResp.clusterArns || [];
      }

      const result = [];
      for (const clusterArn of clusterArns.slice(0, 10)) {
        const clusterName = clusterArn.split("/").pop() || clusterArn;

        // Get services in cluster
        const servicesResp = await client.send(new ListServicesCommand({ cluster: clusterArn, maxResults: 100 }));
        const serviceArns = servicesResp.serviceArns || [];

        if (serviceArns.length === 0) {
          result.push({ cluster: clusterName, services: [] });
          continue;
        }

        const descResp = await client.send(new DescribeServicesCommand({
          cluster: clusterArn,
          services: serviceArns.slice(0, 10),
        }));

        const services = (descResp.services || []).map(svc => ({
          name: svc.serviceName,
          status: svc.status,
          running_count: svc.runningCount,
          desired_count: svc.desiredCount,
          pending_count: svc.pendingCount,
          task_definition: svc.taskDefinition?.split("/").pop(),
          launch_type: svc.launchType,
          created_at: svc.createdAt?.toISOString(),
          events: (svc.events || []).slice(0, 3).map(e => ({ message: e.message, created_at: e.createdAt?.toISOString() })),
        }));

        const unhealthy = services.filter(s => s.running_count !== s.desired_count);

        result.push({
          cluster: clusterName,
          cluster_arn: clusterArn,
          total_services: services.length,
          services,
          alerts: unhealthy.map(s => `Service ${s.name}: running ${s.running_count}/${s.desired_count} desired tasks`),
        });
      }

      return {
        clusters_checked: clusterArns.length,
        region: region || awsConfig().region,
        clusters: result,
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return { error: msg, hint: "Check IAM permissions: ecs:ListClusters, ecs:ListServices, ecs:DescribeServices", timestamp: new Date().toISOString() };
    }
  },

  list_rds_instances: async (args: unknown) => {
    if (!process.env.AWS_ACCESS_KEY_ID) return notConfigured("list_rds_instances");

    const { region } = args as { region?: string };

    try {
      const client = new RDSClient({ ...awsConfig(), region: region || awsConfig().region });

      const [instancesResp, clustersResp] = await Promise.all([
        client.send(new DescribeDBInstancesCommand({})),
        client.send(new DescribeDBClustersCommand({})),
      ]);

      const instances = (instancesResp.DBInstances || []).map(db => ({
        identifier: db.DBInstanceIdentifier,
        engine: `${db.Engine} ${db.EngineVersion}`,
        status: db.DBInstanceStatus,
        class: db.DBInstanceClass,
        endpoint: db.Endpoint?.Address ? `${db.Endpoint.Address}:${db.Endpoint.Port}` : null,
        multi_az: db.MultiAZ,
        storage_gb: db.AllocatedStorage,
        backup_retention_days: db.BackupRetentionPeriod,
        publicly_accessible: db.PubliclyAccessible,
        cluster_id: db.DBClusterIdentifier || null,
      }));

      const clusters = (clustersResp.DBClusters || []).map(c => ({
        identifier: c.DBClusterIdentifier,
        engine: `${c.Engine} ${c.EngineVersion}`,
        status: c.Status,
        endpoint: c.Endpoint,
        reader_endpoint: c.ReaderEndpoint,
        multi_az: c.MultiAZ,
        members: c.DBClusterMembers?.length || 0,
      }));

      const unhealthy = instances.filter(i => i.status !== "available");

      return {
        region: region || awsConfig().region,
        rds_instances: instances,
        aurora_clusters: clusters,
        total_instances: instances.length,
        total_clusters: clusters.length,
        alerts: unhealthy.map(i => `RDS instance ${i.identifier} is in state: ${i.status}`),
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return { error: msg, hint: "Check IAM permissions: rds:DescribeDBInstances, rds:DescribeDBClusters", timestamp: new Date().toISOString() };
    }
  },

  list_load_balancers: async (args: unknown) => {
    if (!process.env.AWS_ACCESS_KEY_ID) return notConfigured("list_load_balancers");

    const { region } = args as { region?: string };

    try {
      const client = new ElasticLoadBalancingV2Client({ ...awsConfig(), region: region || awsConfig().region });

      const lbResp = await client.send(new DescribeLoadBalancersCommand({}));
      const lbs = lbResp.LoadBalancers || [];

      // Get target groups for each LB
      const tgResp = await client.send(new DescribeTargetGroupsCommand({}));
      const tgs = tgResp.TargetGroups || [];

      // Get health for each target group
      const tgHealth = await Promise.all(
        tgs.slice(0, 20).map(async tg => {
          try {
            const health = await client.send(new DescribeTargetHealthCommand({ TargetGroupArn: tg.TargetGroupArn }));
            const targets = health.TargetHealthDescriptions || [];
            return {
              name: tg.TargetGroupName,
              port: tg.Port,
              protocol: tg.Protocol,
              healthy: targets.filter(t => t.TargetHealth?.State === "healthy").length,
              unhealthy: targets.filter(t => t.TargetHealth?.State === "unhealthy").length,
              total: targets.length,
              lb_arns: tg.LoadBalancerArns,
            };
          } catch {
            return { name: tg.TargetGroupName, error: "Could not fetch health" };
          }
        })
      );

      const unhealthyTgs = tgHealth.filter(tg => (tg as { unhealthy?: number }).unhealthy && (tg as { unhealthy: number }).unhealthy > 0);

      return {
        region: region || awsConfig().region,
        load_balancers: lbs.map(lb => ({
          name: lb.LoadBalancerName,
          type: lb.Type,
          scheme: lb.Scheme,
          state: lb.State?.Code,
          dns_name: lb.DNSName,
          created_at: lb.CreatedTime?.toISOString(),
          vpc_id: lb.VpcId,
        })),
        target_groups: tgHealth,
        alerts: unhealthyTgs.map(tg => `Target group ${tg.name} has ${(tg as { unhealthy: number }).unhealthy} unhealthy targets`),
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return { error: msg, hint: "Check IAM permissions: elasticloadbalancing:DescribeLoadBalancers, DescribeTargetGroups, DescribeTargetHealth", timestamp: new Date().toISOString() };
    }
  },
};
