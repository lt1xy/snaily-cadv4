import { TeamSpeak } from "ts3-nodejs-library";

class TeamSpeakService {
  private client: TeamSpeak | null = null;
  private isConnected = false;
  private reconnectAttempts = 0;
  private readonly maxReconnectAttempts = 3;
  
  async connect(config: {
    host: string;
    queryport: number;
    username: string;
    password: string;
    nickname: string;
  }) {
    try {
      this.client = new TeamSpeak({
        host: config.host,
        queryport: config.queryport,
        serverport: 9987, // Default TS3 server port
        username: config.username,
        password: config.password,
        nickname: config.nickname,
        readyTimeout: 10000,
        keepAlive: true
      });
      
      this.setupEventHandlers();
      await this.client.connect();
      this.isConnected = true;
      this.reconnectAttempts = 0;
      console.log("✅ TeamSpeak connected successfully");
    } catch (error) {
      console.error("❌ TeamSpeak connection failed:", error);
      await this.handleReconnection(config);
    }
  }

  private setupEventHandlers() {
    if (!this.client) return;

    this.client.on("close", () => {
      this.isConnected = false;
      console.log("🔌 TeamSpeak connection closed");
    });

    this.client.on("error", (error) => {
      console.error("⚠️ TeamSpeak error:", error);
    });

    this.client.on("ready", () => {
      this.isConnected = true;
      console.log("✅ TeamSpeak connection ready");
    });
  }

  private async handleReconnection(config: any) {
    if (this.reconnectAttempts < this.maxReconnectAttempts) {
      this.reconnectAttempts++;
      console.log(`♻️ Attempting to reconnect (${this.reconnectAttempts}/${this.maxReconnectAttempts})...`);
      await new Promise(resolve => setTimeout(resolve, 5000));
      await this.connect(config);
    } else {
      console.error("🛑 Max reconnection attempts reached");
    }
  }

  async sendMessageToChannel(channelId: string, message: string): Promise<boolean> {
    if (!this.client || !this.isConnected) {
      console.warn("⚠️ TeamSpeak not connected");
      return false;
    }

    try {
      const channelIdNum = Number(channelId);
      if (isNaN(channelIdNum)) {
        throw new Error(`Invalid channel ID: ${channelId}`);
      }

      // Use the correct method name: sendTextMessage
      await this.client.sendTextMessage(channelIdNum, 1, message);
      console.log(`💬 Sent message to channel ${channelId}`);
      return true;
    } catch (error) {
      console.error("❌ Failed to send TeamSpeak message:", error);
      return false;
    }
  }

  async disconnect() {
    if (this.client && this.isConnected) {
      try {
        await this.client.quit();
        this.isConnected = false;
        console.log("🔌 TeamSpeak disconnected");
      } catch (error) {
        console.error("⚠️ Error disconnecting from TeamSpeak:", error);
      }
    }
  }
}
