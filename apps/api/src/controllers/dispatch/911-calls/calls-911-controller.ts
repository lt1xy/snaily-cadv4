import { Controller } from "@tsed/di";
import { ContentType, Delete, Description, Get, Post, Put } from "@tsed/schema";
import {
  UPDATE_ASSIGNED_UNIT_SCHEMA,
  CALL_911_SCHEMA,
  LINK_INCIDENT_TO_CALL_SCHEMA,
  type ASSIGNED_UNIT,
} from "@snailycad/schemas";
import { HeaderParams, BodyParams, Context, PathParams, QueryParams } from "@tsed/platform-params";
import { BadRequest, NotFound } from "@tsed/exceptions";
import { prisma } from "lib/data/prisma";
import { Socket } from "services/socket-service";
import { UseAfter, UseBeforeEach } from "@tsed/platform-middlewares";
import { IsAuth } from "middlewares/auth/is-auth";
import { validateSchema } from "lib/data/validate-schema";
import {
  type cad,
  type User,
  type MiscCadSettings,
  type Call911,
  DiscordWebhookType,
  ShouldDoType,
  type Prisma,
  WhitelistStatus,
  WhatPages,
} from "@prisma/client";
import { sendDiscordWebhook, sendRawWebhook } from "lib/discord/webhooks";
import type { APIEmbed } from "discord-api-types/v10";
import { manyToManyHelper } from "lib/data/many-to-many";
import { Permissions, UsePermissions } from "middlewares/use-permissions";
import { officerOrDeputyToUnit } from "lib/leo/officerOrDeputyToUnit";
import { findUnit } from "lib/leo/findUnit";
import { getInactivityFilter } from "lib/leo/utils";
import { assignUnitsTo911Call } from "lib/dispatch/911-calls/assign-units-to-911-call";
import { linkOrUnlinkCallDepartmentsAndDivisions } from "lib/dispatch/911-calls/link-unlink-departments-divisions-call-911";
import { hasPermission } from "@snailycad/permissions";
import type * as APITypes from "@snailycad/types/api";
import { incidentInclude } from "controllers/leo/incidents/IncidentController";
import type { z } from "zod";
import { getNextActive911CallId } from "lib/dispatch/911-calls/get-next-active-911-call";
import { Feature, IsFeatureEnabled } from "middlewares/is-enabled";
import { getTranslator } from "utils/get-translator";
import { HandleInactivity } from "middlewares/handle-inactivity";
import { handleEndCall } from "lib/dispatch/911-calls/handle-end-911-call";
import { AuditLogActionType, createAuditLogEntry } from "@snailycad/audit-logger/server";
import { isFeatureEnabled } from "lib/upsert-cad";
import { _leoProperties, assignedUnitsInclude, callInclude } from "utils/leo/includes";
import { slateDataToString, type Descendant } from "@snailycad/utils/editor";
import { TeamSpeak } from "teamspeak-client";
import { GoogleGenerativeAI } from "@google/generative-ai";

// ======================== Services ========================

class TeamSpeakService {
  private client: TeamSpeak;
  private isConnected = false;

  constructor() {
    this.client = new TeamSpeak();
  }

  async connect(config: {
    host: string;
    queryport: number;
    username: string;
    password: string;
    nickname: string;
  }) {
    try {
      await this.client.connect(config);
      this.isConnected = true;
      console.log("TeamSpeak connected successfully");
    } catch (error) {
      console.error("TeamSpeak connection failed:", error);
      throw error;
    }
  }

  async sendMessageToChannel(channelId: string, message: string) {
    if (!this.isConnected) {
      console.warn("TeamSpeak not connected, message not sent");
      return;
    }

    try {
      await this.client.send("sendtextmessage", {
        targetmode: 2,
        target: channelId,
        msg: message,
      });
      console.log("TeamSpeak notification sent");
    } catch (error) {
      console.error("Failed to send TeamSpeak message:", error);
    }
  }
}

class GeminiAIService {
  private genAI: GoogleGenerativeAI;
  private model: any;

  constructor() {
    this.genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || "");
    this.model = this.genAI.getGenerativeModel({ model: "gemini-pro" });
  }

  async analyzeCallPriority(callData: {
    description: string;
    location: string;
    callType: string;
  }): Promise<{ priority: number; reasoning: string }> {
    const prompt = `Analyze this 911 call and assign a priority (1=highest, 5=lowest):
    Type: ${callData.callType}
    Location: ${callData.location}
    Description: ${callData.description}
    
    Respond with JSON ONLY: { "priority": number, "reasoning": string }`;

    try {
      const result = await this.model.generateContent(prompt);
      const response = await result.response;
      const text = response.text();
      return JSON.parse(text.trim());
    } catch (error) {
      console.error("Gemini AI error:", error);
      return { priority: 3, reasoning: "Default priority - analysis failed" };
    }
  }
}

// ======================== Controller ========================

@Controller("/911-calls")
@UseBeforeEach(IsAuth)
@ContentType("application/json")
@IsFeatureEnabled({ feature: Feature.CALLS_911 })
export class Calls911Controller {
  private socket: Socket;
  private teamSpeak: TeamSpeakService;
  private gemini: GeminiAIService;

  constructor(socket: Socket) {
    this.socket = socket;
    this.teamSpeak = new TeamSpeakService();
    this.gemini = new GeminiAIService();
    
    this.initializeServices().catch(console.error);
  }

  private async initializeServices() {
    if (process.env.TEAMSPEAK_ENABLED === "true") {
      await this.teamSpeak.connect({
        host: process.env.TEAMSPEAK_HOST || "localhost",
        queryport: parseInt(process.env.TEAMSPEAK_QUERY_PORT || "10011"),
        username: process.env.TEAMSPEAK_USERNAME || "serveradmin",
        password: process.env.TEAMSPEAK_PASSWORD || "",
        nickname: process.env.TEAMSPEAK_NICKNAME || "SnailyCAD Dispatch",
      });
    }
  }

  // ====================== API Endpoints ======================

  @Get("/")
  @Description("Get all 911 calls")
  @UseAfter(HandleInactivity)
  async get911Calls(
    @Context("cad") cad: { miscCadSettings: MiscCadSettings | null },
    @QueryParams("includeEnded", Boolean) includeEnded?: boolean,
    @QueryParams("skip", Number) skip = 0,
    @QueryParams("query", String) query = "",
    @QueryParams("includeAll", Boolean) includeAll = false,
    @QueryParams("take", Number) take = 12,
    @QueryParams("department", String) department?: string,
    @QueryParams("division", String) division?: string,
    @QueryParams("assignedUnit", String) assignedUnit?: string,
  ): Promise<APITypes.Get911CallsData> {
    const inactivityFilter = getInactivityFilter(cad, "call911InactivityTimeout");
    const where: Prisma.Call911WhereInput = {
      ...(includeEnded ? {} : inactivityFilter?.filter ?? {}),
      ended: includeEnded ? undefined : false,
      OR: query ? [
        { descriptionData: { array_contains: query } },
        { name: { contains: query, mode: "insensitive" } },
        { postal: { contains: query, mode: "insensitive" } },
        { location: { contains: query, mode: "insensitive" } },
        { description: { contains: query, mode: "insensitive" } },
        { type: { value: { value: { contains: query, mode: "insensitive" } } },
        { situationCode: { value: { value: { contains: query, mode: "insensitive" } } },
      ] : undefined,
    };

    if (department || division || assignedUnit) {
      where.OR = where.OR || [];
      if (department) where.OR.push({ departments: { some: { id: department } });
      if (division) where.OR.push({ divisions: { some: { id: division } });
      if (assignedUnit) where.OR.push(
        { assignedUnits: { some: { id: assignedUnit } },
        { assignedUnits: { some: { officerId: assignedUnit } },
        { assignedUnits: { some: { emsFdDeputyId: assignedUnit } },
        { assignedUnits: { some: { combinedLeoId: assignedUnit } },
      );
    }

    const [totalCount, calls] = await Promise.all([
      prisma.call911.count({ where }),
      prisma.call911.findMany({
        take: includeAll ? undefined : take,
        skip: includeAll ? undefined : skip,
        include: callInclude,
        orderBy: { updatedAt: "desc" },
        where,
      }),
    ]);

    return { totalCount, calls: calls.map(officerOrDeputyToUnit) };
  }

  @Post("/")
  async create911Call(
    @BodyParams() body: unknown,
    @Context("user") user: User,
    @Context("cad") cad: cad & { features?: Record<Feature, boolean>; miscCadSettings: MiscCadSettings },
    @HeaderParams("is-from-dispatch") isFromDispatchHeader?: string,
  ): Promise<APITypes.Post911CallsData> {
    const data = validateSchema(CALL_911_SCHEMA, body);
    const hasDispatchPermissions = hasPermission({
      userToCheck: user,
      permissionsToCheck: [Permissions.Dispatch],
    });

    const isFromDispatch = isFromDispatchHeader === "true" && hasDispatchPermissions;
    const maxAssignmentsToCalls = cad.miscCadSettings.maxAssignmentsToCalls ?? Infinity;
    const isCallApprovalEnabled = isFeatureEnabled({
      defaultReturn: false,
      feature: Feature.CALL_911_APPROVAL,
      features: cad.features,
    });

    const activeDispatchers = await prisma.activeDispatchers.count();
    const hasActiveDispatchers = activeDispatchers > 0;
    const shouldCallBePending = isCallApprovalEnabled && hasActiveDispatchers && !isFromDispatch;
    const callStatus = shouldCallBePending ? WhitelistStatus.PENDING : WhitelistStatus.ACCEPTED;

    const priorityAnalysis = await this.gemini.analyzeCallPriority({
      description: data.descriptionData ? slateDataToString(data.descriptionData) : data.description || "",
      location: data.location || "",
      callType: data.type,
    });

    const call = await prisma.call911.create({
      data: {
        location: data.location ?? undefined,
        postal: data.postal ?? undefined,
        description: data.descriptionData ? null : data.description,
        descriptionData: data.descriptionData ?? undefined,
        name: data.name ?? undefined,
        userId: user.id || undefined,
        situationCodeId: data.situationCode ?? null,
        viaDispatch: isFromDispatch,
        typeId: data.type,
        extraFields: data.extraFields || undefined,
        status: callStatus,
        priority: priorityAnalysis.priority,
        priorityReason: priorityAnalysis.reasoning,
      },
      include: callInclude,
    });

    if (data.gtaMapPosition) {
      await prisma.gTAMapPosition.create({
        data: {
          x: data.gtaMapPosition.x,
          y: data.gtaMapPosition.y,
          z: data.gtaMapPosition.z,
          heading: data.gtaMapPosition.heading,
          Call911: { connect: { id: call.id } },
        },
      });
    }

    const unitIds = (data.assignedUnits ?? []) as z.infer<typeof ASSIGNED_UNIT>[];
    await assignUnitsTo911Call({
      call,
      maxAssignmentsToCalls,
      socket: this.socket,
      unitIds,
    });

    await linkOrUnlinkCallDepartmentsAndDivisions({
      departments: (data.departments ?? []) as string[],
      divisions: (data.divisions ?? []) as string[],
      call,
    });

    const updated = await prisma.call911.findUnique({
      where: { id: call.id },
      include: callInclude,
    });

    const normalizedCall = officerOrDeputyToUnit(updated);

    await createAuditLogEntry({
      action: { type: AuditLogActionType.Call911Create, new: normalizedCall },
      executorId: user.id,
      prisma,
    });

    try {
      const webhookData = await this.createWebhookData(normalizedCall, user.locale);
      await sendDiscordWebhook({ type: DiscordWebhookType.CALL_911, data: webhookData });
      await sendRawWebhook({ type: DiscordWebhookType.CALL_911, data: normalizedCall });
    } catch (error) {
      console.error("Discord webhook error:", error);
    }

    try {
      await this.sendTeamSpeakNotification(normalizedCall, user.locale);
    } catch (error) {
      console.error("TeamSpeak notification error:", error);
    }

    this.socket.emit911Call(normalizedCall);
    return normalizedCall;
  }

  @Get("/:id")
  @Description("Get a call by its id or caseNumber")
  @UsePermissions({
    permissions: [Permissions.Dispatch, Permissions.Leo, Permissions.EmsFd],
  })
  async getCallById(@PathParams("id") id: string): Promise<APITypes.Get911CallByIdData> {
    const where = Number.isNaN(parseInt(id)) ? { id } : { caseNumber: parseInt(id) };
    const call = await prisma.call911.findFirst({ where, include: callInclude });

    if (!call) throw new NotFound("callNotFound");
    return officerOrDeputyToUnit(call);
  }

  @Put("/:id")
  @UsePermissions({
    permissions: [Permissions.Dispatch, Permissions.EmsFd, Permissions.Leo],
  })
  async update911Call(
    @PathParams("id") id: string,
    @BodyParams() body: unknown,
    @Context("user") user: User,
    @Context("cad") cad: cad & { miscCadSettings: MiscCadSettings },
  ): Promise<APITypes.Put911CallByIdData> {
    const data = validateSchema(CALL_911_SCHEMA.partial(), body);
    const call = await prisma.call911.findUnique({
      where: { id },
      include: { assignedUnits: assignedUnitsInclude, departments: true, divisions: true },
    });

    if (!call || call.ended) throw new NotFound("callNotFound");

    const position = data.position ? await prisma.position.upsert({
      where: { id: call.positionId ?? "undefined" },
      create: {
        lat: parseFloat(data.position.lat) || 0.0,
        lng: parseFloat(data.position.lng) || 0.0,
      },
      update: {
        lat: parseFloat(data.position.lat) || 0.0,
        lng: parseFloat(data.position.lng) || 0.0,
      },
    }) : null;

    await prisma.call911.update({
      where: { id },
      data: {
        location: data.location,
        postal: data.postal,
        description: data.descriptionData ? null : data.description,
        name: data.name,
        userId: user.id,
        positionId: data.position === null ? null : position?.id ?? call.positionId,
        descriptionData: data.descriptionData ?? undefined,
        situationCodeId: data.situationCode === null ? null : data.situationCode,
        typeId: data.type,
        extraFields: data.extraFields || undefined,
        status: (data.status as WhitelistStatus | null) || undefined,
        gtaMapPositionId: data.gtaMapPosition === null ? null : undefined,
        ...(data.description || data.descriptionData) ? {
          priority: undefined,
          priorityReason: undefined
        } : {}
      },
    });

    if (data.gtaMapPosition) {
      await prisma.gTAMapPosition.upsert({
        where: { id: String(call.gtaMapPositionId) },
        create: {
          x: data.gtaMapPosition.x,
          y: data.gtaMapPosition.y,
          z: data.gtaMapPosition.z,
          heading: data.gtaMapPosition.heading,
        },
        update: {
          x: data.gtaMapPosition.x,
          y: data.gtaMapPosition.y,
          z: data.gtaMapPosition.z,
          heading: data.gtaMapPosition.heading,
        },
      });
    }

    if (data.description || data.descriptionData) {
      const priorityAnalysis = await this.gemini.analyzeCallPriority({
        description: data.descriptionData ? slateDataToString(data.descriptionData) : data.description || "",
        location: data.location || call.location,
        callType: data.type || call.typeId,
      });

      await prisma.call911.update({
        where: { id },
        data: {
          priority: priorityAnalysis.priority,
          priorityReason: priorityAnalysis.reasoning,
        },
      });
    }

    if (data.assignedUnits) {
      await assignUnitsTo911Call({
        call: { ...call, id },
        maxAssignmentsToCalls: cad.miscCadSettings.maxAssignmentsToCalls ?? Infinity,
        unitIds: data.assignedUnits as z.infer<typeof ASSIGNED_UNIT>[],
      });
    }

    if (data.departments || data.divisions) {
      await linkOrUnlinkCallDepartmentsAndDivisions({
        departments: (data.departments ?? []) as string[],
        divisions: (data.divisions ?? []) as string[],
        call: { ...call, id },
      });
    }

    const updated = await prisma.call911.findUnique({
      where: { id },
      include: callInclude,
    });

    const normalizedCall = officerOrDeputyToUnit(updated);
    this.socket.emitUpdate911Call(normalizedCall);
    return normalizedCall;
  }

  @Delete("/purge")
  @UsePermissions({
    permissions: [Permissions.ManageCallHistory],
  })
  async purgeCalls(
    @BodyParams("ids") ids: string[],
    @Context("sessionUserId") sessionUserId: string,
  ): Promise<APITypes.DeletePurge911CallsData> {
    if (!Array.isArray(ids)) return false;

    await Promise.all(
      ids.map(async (id) => {
        const call = await prisma.call911.delete({ where: { id } });
        this.socket.emit911CallDelete(call);
      }),
    );

    await createAuditLogEntry({
      translationKey: "calls911Purged",
      action: { type: AuditLogActionType.Calls911Purge, new: ids },
      executorId: sessionUserId,
      prisma,
    });

    return true;
  }

  @Delete("/:id")
  @UsePermissions({
    permissions: [Permissions.Dispatch, Permissions.Leo, Permissions.EmsFd],
  })
  async end911Call(@PathParams("id") id: string): Promise<APITypes.Delete911CallByIdData> {
    const call = await prisma.call911.findUnique({
      where: { id },
      include: { assignedUnits: true },
    });

    if (!call || call.ended) throw new NotFound("callNotFound");

    await handleEndCall({ call, socket: this.socket });
    await Promise.all([
      this.socket.emit911CallDelete(call),
      this.socket.emitUpdateOfficerStatus(),
      this.socket.emitUpdateDeputyStatus(),
    ]);

    return true;
  }

  @Post("/link-incident/:callId")
  @UsePermissions({
    permissions: [Permissions.ManageCallHistory],
  })
  async linkCallToIncident(
    @PathParams("callId") callId: string,
    @BodyParams() body: unknown,
  ): Promise<APITypes.PostLink911CallToIncident> {
    const data = validateSchema(LINK_INCIDENT_TO_CALL_SCHEMA, body);
    const call = await prisma.call911.findUnique({
      where: { id: callId },
      include: { incidents: true },
    });

    if (!call) throw new NotFound("callNotFound");

    const disconnectConnectArr = manyToManyHelper(
      call.incidents.map((v) => v.id),
      data.incidentIds as string[],
      { showUpsert: false },
    );

    await prisma.$transaction(
      disconnectConnectArr.map((v) =>
        prisma.call911.update({ where: { id: call.id }, data: { incidents: v } }),
      ),
    );

    const updated = await prisma.call911.findUnique({
      where: { id: call.id },
      include: { incidents: { include: incidentInclude } },
    });

    return officerOrDeputyToUnit({
      ...call,
      incidents: updated?.incidents.map(officerOrDeputyToUnit) ?? [],
    });
  }

  @Post("/:type/:callId")
  @UsePermissions({
    permissions: [Permissions.Dispatch, Permissions.Leo, Permissions.EmsFd],
  })
  async assignToCall(
    @PathParams("type") callType: "assign" | "unassign",
    @PathParams("callId") callId: string,
    @BodyParams("unit") rawUnitId: string | null,
    @QueryParams("force", Boolean) force = false,
  ): Promise<APITypes.Post911CallAssignUnAssign> {
    if (!rawUnitId) throw new BadRequest("unitIsRequired");

    const { unit, type } = await findUnit(rawUnitId);
    if (!unit) throw new NotFound("unitNotFound");

    const call = await prisma.call911.findUnique({ where: { id: callId } });
    if (!call) throw new NotFound("callNotFound");

    const types = {
      "combined-leo": "combinedLeoId",
      "combined-ems-fd": "combinedEmsFdId",
      leo: "officerId",
      "ems-fd": "emsFdDeputyId",
    };

    const existing = await prisma.assignedUnit.findFirst({
      where: { call911Id: callId, [types[type]]: unit.id },
    });

    if (callType === "assign") {
      if (existing) throw new BadRequest("alreadyAssignedToCall");
      await prisma.assignedUnit.create({
        data: { call911Id: callId, [types[type]]: unit.id },
      });
    } else {
      if (!existing) throw new BadRequest("notAssignedToCall");
      await prisma.assignedUnit.delete({ where: { id: existing.id } });
    }

    const prismaNames = {
      leo: "officer",
      "ems-fd": "emsFdDeputy",
      "combined-leo": "combinedLeoUnit",
      "combined-ems-fd": "combinedEmsFdUnit",
    };

    const pageType = ["leo", "combined-leo"].includes(type) ? WhatPages.LEO : WhatPages.EMS_FD;
    const assignedToStatus = await prisma.statusValue.findFirst({
      where: {
        shouldDo: callType === "assign" ? ShouldDoType.SET_ASSIGNED : ShouldDoType.SET_ON_DUTY,
        OR: callType === "assign" ? undefined : [
          { whatPages: { isEmpty: true } },
          { whatPages: { has: pageType } },
        ],
      },
    });

    await prisma[prismaNames[type]].update({
      where: { id: unit.id },
      data: {
        activeCallId: await getNextActive911CallId({
          callId: call.id,
          type: callType,
          unit,
          force,
        }),
        statusId: assignedToStatus?.id,
      },
    });

    await Promise.all([
      this.socket.emitUpdateOfficerStatus(),
      this.socket.emitUpdateDeputyStatus(),
    ]);

    const updated = await prisma.call911.findUnique({
      where: { id: call.id },
      include: callInclude,
    });

    this.socket.emitUpdate911Call(officerOrDeputyToUnit(updated));
    return officerOrDeputyToUnit(updated);
  }

  @Put("/:callId/assigned-units/:assignedUnitId")
  @UsePermissions({
    permissions: [Permissions.Dispatch, Permissions.Leo, Permissions.EmsFd],
  })
  async updateAssignedUnit(
    @PathParams("callId") callId: string,
    @PathParams("assignedUnitId") assignedUnitId: string,
    @BodyParams() body: unknown,
  ): Promise<APITypes.PUT911CallAssignedUnit> {
    const data = validateSchema(UPDATE_ASSIGNED_UNIT_SCHEMA, body);
    const call = await prisma.call911.findUnique({ where: { id: callId } });
    if (!call) throw new NotFound("callNotFound");

    if (data.isPrimary) {
      await prisma.assignedUnit.updateMany({
        where: { call911Id: call.id },
        data: { isPrimary: false },
      });
    }

    const assignedUnit = await prisma.assignedUnit.findUnique({
      where: { id: assignedUnitId },
    });
    if (!assignedUnit) throw new NotFound("unitNotFound");

    const updatedCall = await prisma.call911.update({
      where: { id: call.id },
      data: {
        assignedUnits: {
          update: { where: { id: assignedUnit.id }, data: { isPrimary: data.isPrimary } },
        },
      },
      include: callInclude,
    });

    const normalizedCall = officerOrDeputyToUnit(updatedCall);
    this.socket.emitUpdate911Call(normalizedCall);
    return normalizedCall;
  }

  // ====================== Helper Methods ======================

  private async sendTeamSpeakNotification(call: Call911, locale?: string | null) {
    if (!this.teamSpeak) return;

    const t = await getTranslator({ type: "webhooks", locale, namespace: "Calls" });
    const description = call.descriptionData 
      ? slateDataToString(call.descriptionData) 
      : call.description || t("noDescription");

    const message = [
      `📞 911 Call | Priority ${call.priority || 3}`,
      `Caller: ${call.name || t("unknown")}`,
      `Location: ${call.location}${call.postal ? ` (${call.postal})` : ""}`,
      `Type: ${call.type}`,
      `Desc: ${description.substring(0, 50)}${description.length > 50 ? "..." : ""}`
    ].join(" | ");

    await this.teamSpeak.sendMessageToChannel(process.env.TEAMSPEAK_CHANNEL_ID || "1", message);
  }

  private async createWebhookData(
    call: Call911,
    locale?: string | null,
  ): Promise<{ embeds: APIEmbed[] }> {
    const t = await getTranslator({ type: "webhooks", locale, namespace: "Calls" });
    const description = call.descriptionData 
      ? slateDataToString(call.descriptionData) 
      : call.description || t("noDescription");

    return {
      embeds: [{
        title: t("callCreated"),
        description,
        fields: [
          { name: t("caller"), value: call.name || t("unknown"), inline: true },
          { name: t("location"), value: `${call.location}${call.postal ? ` (${call.postal})` : ""}`, inline: true },
          { name: "Priority", value: `${call.priority || 3}${call.priorityReason ? ` (${call.priorityReason})` : ""}`, inline: true },
        ],
        color: this.getPriorityColor(call.priority),
        timestamp: new Date().toISOString(),
      }]
    };
  }

  private getPriorityColor(priority?: number): number {
    switch (priority) {
      case 1: return 0xff0000; // Red - Emergency
      case 2: return 0xff4500; // OrangeRed - High
      case 3: return 0xffa500; // Orange - Medium
      case 4: return 0xffff00; // Yellow - Low
      case 5: return 0x00ff00; // Green - Info
      default: return 0x3498db; // Blue - Unknown
    }
  }
}
