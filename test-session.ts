import Browserbase from "@browserbasehq/sdk";

const apiKey = process.env.BROWSERBASE_API_KEY!.trim();
const projectId = process.env.BROWSERBASE_PROJECT_ID!.trim();

console.log("API Key repr:", JSON.stringify(apiKey));
console.log("Project repr:", JSON.stringify(projectId));
console.log("Project length:", projectId.length);
console.log("Expected length:", "cd060316-4ca4-49c7-881e-63b9cabd1735".length);

const bb = new Browserbase({ apiKey });

async function test() {
  try {
    const session = await bb.sessions.create({
      projectId,
      proxies: [
        {
          type: "browserbase",
          geolocation: { country: "AU", city: "Melbourne" },
        },
      ],
      browserSettings: {
        recordSession: true,
        logSession: true,
        solveCaptchas: true,
      },
      keepAlive: true,
    });
    console.log("✅ Session created:", session.id);
    console.log("Connect URL:", session.connectUrl?.substring(0, 60));
  } catch (e: any) {
    console.error("❌ Error:", e.message);
    console.error("Full:", JSON.stringify(e.error, null, 2));
  }
}

test();
