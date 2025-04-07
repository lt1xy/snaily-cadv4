import { TeamSpeak } from "ts3-nodejs-library";

class TeamSpeakService {
  private client: TeamSpeak | null = null;
  
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
        nickname: config.nickname
      });

      await this.client.connect();
      console.log("TeamSpeak connected successfully");
    } catch (error) {
      console.error("TeamSpeak connection failed:", error);
      throw error;
    }
  }

  async sendMessageToChannel(channelId: string, message: string) {
    if (!this.client) {
      console.warn("TeamSpeak not connected, message not sent");
      return;
    }

    try {
      // Find the channel by ID
      const channel = await this.client.getChannelById(channelId);
      if (!channel) {
        throw new Error("Channel not found");
      }
      
      // Send message to channel
      await this.client.sendTextMessage(channel.cid, 1, message); // 1 = Channel message
      console.log("TeamSpeak notification sent to channel", channelId);
    } catch (error) {
      console.error("Failed to send TeamSpeak message:", error);
    }
  }

  async disconnect() {
    if (this.client) {
      await this.client.quit();
      this.client = null;
    }
  }
}
