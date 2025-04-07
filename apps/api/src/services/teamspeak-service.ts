// apps/api/src/services/teamspeak-service.ts
import { TeamSpeak } from "teamspeak-client";

export class TeamSpeakService {
  private client: TeamSpeak;
  private isConnected = false;

  constructor() {
    this.client = new TeamSpeak();
  }

  async connect(options: {
    host: string;
    queryport: number;
    username: string;
    password: string;
    nickname: string;
  }) {
    try {
      await this.client.connect(options);
      this.isConnected = true;
      console.log("Successfully connected to TeamSpeak server");
    } catch (error) {
      console.error("TeamSpeak connection error:", error);
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
        targetmode: 2, // Channel message
        target: channelId,
        msg: message,
      });
      console.log("TeamSpeak message sent successfully");
    } catch (error) {
      console.error("TeamSpeak message error:", error);
      throw error;
    }
  }

  async disconnect() {
    if (this.isConnected) {
      try {
        await this.client.quit();
        this.isConnected = false;
        console.log("Disconnected from TeamSpeak server");
      } catch (error) {
        console.error("Error disconnecting from TeamSpeak:", error);
      }
    }
  }

  get connectionStatus() {
    return this.isConnected;
  }
}
