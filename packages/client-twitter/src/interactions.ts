import {
    composeContext,
    Content,
    elizaLogger,
    generateMessageResponse,
    getEmbeddingZeroVector,
    HandlerCallback,
    IAgentRuntime,
    IImageDescriptionService,
    Memory,
    messageCompletionFooter,
    ModelClass,
    ServiceType,
    shouldRespondFooter,
    State,
    stringToUuid,
} from "@elizaos/core";
import { SearchMode, Tweet } from "agent-twitter-client";
import { ClientBase } from "./base";
import { buildConversationThread, sendTweet, wait } from "./utils.ts";

export const twitterMessageHandlerTemplate =
    `
# Areas of Expertise
{{knowledge}}

# About {{agentName}} (@{{twitterUserName}}):
{{bio}}
{{lore}}
{{topics}}

{{providers}}

{{characterPostExamples}}
{{characterMessageExamples}}

{{postDirections}}

---

# **TASK: Generate a structured JSON response for processing an NFT Sale or Purchase request**
This JSON output will be processed by our system for further actions.

## **NFT Sale Request Handling**
- If a user tags {{agentName}} in a tweet for selling an NFT, extract the following details:
- **Blockchain** (chainName or chainId)
- **NFT Contract Address**
- **Token ID**
- **Price**

### **Response Logic**
1. **If details are missing**
- Request the user to provide missing details before proceeding.
- Example reply:
\`\`\`json
{
    "details": null,
    "tweet": "🚨 Missing details detected! Please provide: [Missing Details]. Required format: Chain, Contract Address, Token ID, and Price. Let’s ensure a smooth and secure trade! 🔐"
    }
    \`\`\`

    2. **If all details are provided**
    - Example reply:
    \`\`\`json
    {
        "details": {
            "assetType": "nft",
            "chainId": {{chainId}},
            "contractAddress": "{{contractAddress}}",
            "tokenId": {{tokenId}},
            "tokenAmount": {{tokenAmount}},
            "tokenSymbol": "{{tokenSymbol}}"
            },
            "tweet": "✅ NFT #{{tokenId}} listed on {{chainName}} at {{price}}. Verified sale initiated! Buyers, reply to this tweet to proceed. 🔄 Security first! Make sure your wallet is verified."
            }
            \`\`\`

            ---

            ## **NFT Purchase Interest Handling**
            - When a user replies to an NFT sale tweet showing interest in buying:
            - **You will be given a boolean value** \`userRegistered\` to determine if the user exists in the database.

            ### **Response Logic**
            1. **If user exists (\`userRegistered = true\`)**
            - Notify the seller and instruct the buyer to complete the transaction in their wallet.
            - Example reply:
            \`\`\`json
            {
                "details": {
                    "assetType": "nft",
                    "chainId": {{chainId}},
                    "contractAddress": "{{contractAddress}}",
                    "tokenId": {{tokenId}},
                    "tokenAmount": 1,
                    "tokenSymbol": "{{tokenSymbol}}"
                    },
                    "tweet": "🔔 Notified seller! Please complete the transaction in your wallet. Ensure security before proceeding. Need help? [link]"
                    }
                    \`\`\`

                    2. **If user does not exist (\`userRegistered = false\`)**
                    - Prompt the user to install the wallet.
                    - Example reply:
                    \`\`\`json
                    {
                        "details": null,
                        "tweet": "⚠️ Looks like you don’t have a verified wallet! Download [Wallet Name] to proceed with secure transactions. Need assistance? [link]"
                        }
                        \`\`\`

                        ---

                        # **INSTRUCTIONS:**
                        1. **Strictly output the JSON format** as demonstrated above.
                        2. **No extra explanations, no greetings, no additional text.**
                        3. **Follow the response logic for missing details, valid sales, and purchase requests.**

                        ---

                        ## **Thread of Tweets You Are Replying To:**
                        {{formattedConversation}}

                        {{currentPost}}
                        Here is the description of images in the Current post:
                        {{imageDescriptions}}
                        ` + messageCompletionFooter;

// Recent interactions between {{agentName}} and other users:
// {{recentPostInteractions}}

// {{recentPosts}}

export const twitterShouldRespondTemplate = (targetUsersStr: string) =>
    `# INSTRUCTIONS: Determine if {{agentName}} (@{{twitterUserName}}) should respond to the message and participate in the conversation. Do not comment. Just respond with "RESPOND", "IGNORE", or "STOP".

## **Response Options**
- RESPOND: If {{agentName}} should actively reply.
- IGNORE: If the message is irrelevant or does not require a response.
- STOP: If {{agentName}} should stop participating in the conversation.

## **PRIORITY RULE**
ALWAYS RESPOND to these users regardless of topic or message content: ${targetUsersStr}. Topic relevance should be ignored for these users.

## **Response Logic**
1. **NFT Sale Requests**
   - RESPOND if a user tags {{agentName}} to sell an NFT and includes the required details:
     - **Chain Name or Chain ID**
     - **NFT Contract Address**
     - **Token ID**
     - **Price**
   - RESPOND by asking for missing details if any are omitted.
   - IGNORE if the message is too vague and doesn’t mention an NFT sale.

2. **NFT Purchase Interest**
   - RESPOND if a user expresses interest in buying an NFT by replying to a sale post.
   - CHECK if the user exists in the wallet database:
     - If **user exists**, notify the seller and instruct the buyer to complete the transaction.
     - If **user does not exist**, prompt them to install the wallet.
   - IGNORE if the reply is unclear, lacks an NFT reference, or is off-topic.

3. **Security & Verification**
   - RESPOND to queries about wallet security, transaction verification, or cross-chain transfers.
   - IGNORE if the message is unrelated to blockchain transactions, NFT sales, or wallet security.

4. **Engagement & Conversation**
   - RESPOND to direct mentions with relevant inquiries.
   - IGNORE very short messages unless directly addressed.
   - STOP if asked to stop or if the conversation is concluded.

## **IMPORTANT:**
- {{agentName}} (aka @{{twitterUserName}}) prioritizes efficiency and security.
- To prevent spam, if there is **any doubt**, IGNORE rather than RESPOND.
- If a response is needed but details are missing, ask for clarification rather than assuming.


Current Post:
{{currentPost}}

Thread of Tweets You Are Replying To:
{{formattedConversation}}

# **INSTRUCTIONS:**
Respond with **[RESPOND]** if {{agentName}} should reply, **[IGNORE]** if not, and **[STOP]** if the conversation should end.
` + shouldRespondFooter;
// ## **Recent Activity**
// Recent Posts:
// {{recentPosts}}

export class TwitterInteractionClient {
    client: ClientBase;
    runtime: IAgentRuntime;
    private isDryRun: boolean;
    constructor(client: ClientBase, runtime: IAgentRuntime) {
        this.client = client;
        this.runtime = runtime;
        this.isDryRun = this.client.twitterConfig.TWITTER_DRY_RUN;
    }

    async start() {
        const handleTwitterInteractionsLoop = () => {
            this.handleTwitterInteractions();
            setTimeout(
                handleTwitterInteractionsLoop,
                // Defaults to 2 minutes
                this.client.twitterConfig.TWITTER_POLL_INTERVAL * 1000
            );
        };
        handleTwitterInteractionsLoop();
    }

    async handleTwitterInteractions() {
        elizaLogger.log("Checking Twitter interactions");

        const twitterUsername = this.client.profile.username;
        try {
            // Check for mentions
            const mentionCandidates = (
                await this.client.fetchSearchTweets(
                    `@${twitterUsername}`,
                    20,
                    SearchMode.Latest
                )
            ).tweets;

            elizaLogger.log(
                "Completed checking mentioned tweets:",
                mentionCandidates.length
            );
            let uniqueTweetCandidates = [...mentionCandidates];
            // Only process target users if configured
            if (this.client.twitterConfig.TWITTER_TARGET_USERS.length) {
                const TARGET_USERS =
                    this.client.twitterConfig.TWITTER_TARGET_USERS;

                elizaLogger.log("Processing target users:", TARGET_USERS);

                if (TARGET_USERS.length > 0) {
                    // Create a map to store tweets by user
                    const tweetsByUser = new Map<string, Tweet[]>();

                    // Fetch tweets from all target users
                    for (const username of TARGET_USERS) {
                        try {
                            const userTweets = (
                                await this.client.twitterClient.fetchSearchTweets(
                                    `from:${username}`,
                                    3,
                                    SearchMode.Latest
                                )
                            ).tweets;

                            // Filter for unprocessed, non-reply, recent tweets
                            const validTweets = userTweets.filter((tweet) => {
                                const isUnprocessed =
                                    !this.client.lastCheckedTweetId ||
                                    parseInt(tweet.id) >
                                        this.client.lastCheckedTweetId;
                                const isRecent =
                                    Date.now() - tweet.timestamp * 1000 <
                                    2 * 60 * 60 * 1000;

                                elizaLogger.log(`Tweet ${tweet.id} checks:`, {
                                    isUnprocessed,
                                    isRecent,
                                    isReply: tweet.isReply,
                                    isRetweet: tweet.isRetweet,
                                });

                                return (
                                    isUnprocessed &&
                                    !tweet.isReply &&
                                    !tweet.isRetweet &&
                                    isRecent
                                );
                            });

                            if (validTweets.length > 0) {
                                tweetsByUser.set(username, validTweets);
                                elizaLogger.log(
                                    `Found ${validTweets.length} valid tweets from ${username}`
                                );
                            }
                        } catch (error) {
                            elizaLogger.error(
                                `Error fetching tweets for ${username}:`,
                                error
                            );
                            continue;
                        }
                    }

                    // Select one tweet from each user that has tweets
                    const selectedTweets: Tweet[] = [];
                    for (const [username, tweets] of tweetsByUser) {
                        if (tweets.length > 0) {
                            // Randomly select one tweet from this user
                            const randomTweet =
                                tweets[
                                    Math.floor(Math.random() * tweets.length)
                                ];
                            selectedTweets.push(randomTweet);
                            elizaLogger.log(
                                `Selected tweet from ${username}: ${randomTweet.text?.substring(0, 100)}`
                            );
                        }
                    }

                    // Add selected tweets to candidates
                    uniqueTweetCandidates = [
                        ...mentionCandidates,
                        ...selectedTweets,
                    ];
                }
            } else {
                elizaLogger.log(
                    "No target users configured, processing only mentions"
                );
            }

            // Sort tweet candidates by ID in ascending order
            uniqueTweetCandidates
                .sort((a, b) => a.id.localeCompare(b.id))
                .filter((tweet) => tweet.userId !== this.client.profile.id);

            // for each tweet candidate, handle the tweet
            for (const tweet of uniqueTweetCandidates) {
                if (
                    !this.client.lastCheckedTweetId ||
                    BigInt(tweet.id) > this.client.lastCheckedTweetId
                ) {
                    // Generate the tweetId UUID the same way it's done in handleTweet
                    const tweetId = stringToUuid(
                        tweet.id + "-" + this.runtime.agentId
                    );

                    // Check if we've already processed this tweet
                    const existingResponse =
                        await this.runtime.messageManager.getMemoryById(
                            tweetId
                        );

                    if (existingResponse) {
                        elizaLogger.log(
                            `Already responded to tweet ${tweet.id}, skipping`
                        );
                        continue;
                    }
                    elizaLogger.log("New Tweet found", tweet.permanentUrl);

                    const roomId = stringToUuid(
                        tweet.conversationId + "-" + this.runtime.agentId
                    );

                    const userIdUUID =
                        tweet.userId === this.client.profile.id
                            ? this.runtime.agentId
                            : stringToUuid(tweet.userId!);

                    await this.runtime.ensureConnection(
                        userIdUUID,
                        roomId,
                        tweet.username,
                        tweet.name,
                        "twitter"
                    );

                    const thread = await buildConversationThread(
                        tweet,
                        this.client
                    );

                    const message = {
                        content: { text: tweet.text },
                        agentId: this.runtime.agentId,
                        userId: userIdUUID,
                        roomId,
                    };

                    await this.handleTweet({
                        tweet,
                        message,
                        thread,
                    });

                    // Update the last checked tweet ID after processing each tweet
                    this.client.lastCheckedTweetId = BigInt(tweet.id);
                }
            }

            // Save the latest checked tweet ID to the file
            await this.client.cacheLatestCheckedTweetId();

            elizaLogger.log("Finished checking Twitter interactions");
        } catch (error) {
            elizaLogger.error("Error handling Twitter interactions:", error);
        }
    }

    private async handleTweet({
        tweet,
        message,
        thread,
    }: {
        tweet: Tweet;
        message: Memory;
        thread: Tweet[];
    }) {
        if (tweet.userId === this.client.profile.id) {
            // console.log("skipping tweet from bot itself", tweet.id);
            // Skip processing if the tweet is from the bot itself
            return;
        }

        if (!message.content.text) {
            elizaLogger.log("Skipping Tweet with no text", tweet.id);
            return { text: "", action: "IGNORE" };
        }

        elizaLogger.log("Processing Tweet: ", tweet.id);
        const formatTweet = (tweet: Tweet) => {
            return `  ID: ${tweet.id}
  From: ${tweet.name} (@${tweet.username})
  Text: ${tweet.text}`;
        };
        const currentPost = formatTweet(tweet);

        elizaLogger.debug("Thread: ", thread);
        const formattedConversation = thread
            .map(
                (tweet) => `@${tweet.username} (${new Date(
                    tweet.timestamp * 1000
                ).toLocaleString("en-US", {
                    hour: "2-digit",
                    minute: "2-digit",
                    month: "short",
                    day: "numeric",
                })}):
        ${tweet.text}`
            )
            .join("\n\n");

        elizaLogger.debug("formattedConversation: ", formattedConversation);

        const imageDescriptionsArray = [];
        try {
            elizaLogger.debug("Getting images");
            for (const photo of tweet.photos) {
                elizaLogger.debug(photo.url);
                const description = await this.runtime
                    .getService<IImageDescriptionService>(
                        ServiceType.IMAGE_DESCRIPTION
                    )
                    .describeImage(photo.url);
                imageDescriptionsArray.push(description);
            }
        } catch (error) {
            // Handle the error
            elizaLogger.error("Error Occured during describing image: ", error);
        }

        let state = await this.runtime.composeState(message, {
            twitterClient: this.client.twitterClient,
            twitterUserName: this.client.twitterConfig.TWITTER_USERNAME,
            currentPost,
            formattedConversation,
            imageDescriptions:
                imageDescriptionsArray.length > 0
                    ? `\nImages in Tweet:\n${imageDescriptionsArray
                          .map(
                              (desc, i) =>
                                  `Image ${i + 1}: Title: ${desc.title}\nDescription: ${desc.description}`
                          )
                          .join("\n\n")}`
                    : "",
        });

        // check if the tweet exists, save if it doesn't
        const tweetId = stringToUuid(tweet.id + "-" + this.runtime.agentId);
        const tweetExists =
            await this.runtime.messageManager.getMemoryById(tweetId);

        if (!tweetExists) {
            elizaLogger.log("tweet does not exist, saving");
            const userIdUUID = stringToUuid(tweet.userId as string);
            const roomId = stringToUuid(tweet.conversationId);

            const message = {
                id: tweetId,
                agentId: this.runtime.agentId,
                content: {
                    text: tweet.text,
                    url: tweet.permanentUrl,
                    inReplyTo: tweet.inReplyToStatusId
                        ? stringToUuid(
                              tweet.inReplyToStatusId +
                                  "-" +
                                  this.runtime.agentId
                          )
                        : undefined,
                },
                userId: userIdUUID,
                roomId,
                createdAt: tweet.timestamp * 1000,
            };
            this.client.saveRequestMessage(message, state);
        }

        // get usernames into str
        // const validTargetUsersStr =
        //     this.client.twitterConfig.TWITTER_TARGET_USERS.join(",");

        // const shouldRespondContext = composeContext({
        //     state,
        //     template:
        //         this.runtime.character.templates
        //             ?.twitterShouldRespondTemplate ||
        //         this.runtime.character?.templates?.shouldRespondTemplate ||
        //         twitterShouldRespondTemplate(validTargetUsersStr),
        // });

        // const shouldRespond = await generateShouldRespond({
        //     runtime: this.runtime,
        //     context: shouldRespondContext,
        //     modelClass: ModelClass.MEDIUM,
        // });
        let userExists;

        if (tweet.isReply) {
            console.log({ tweet });
            async function checkUserExists(userTwitterId: string) {
                try {
                    const res = await fetch(
                        "http://localhost:8080/agent/twitter/notify-user",
                        {
                            method: "POST",
                            headers: {
                                "Content-Type": "application/json",
                            },
                            body: JSON.stringify({
                                twitterUserId: userTwitterId,
                                tweetId: tweet.inReplyToStatusId,
                            }),
                        }
                    );

                    const data = await res.json();

                    if (res.ok) {
                        return data.exists
                            ? {
                                  exists: true,
                                  user: data.user,
                                  notified: data.userNotified,
                              }
                            : { exists: false, notified: false };
                    } else {
                        throw new Error(data.message || "Something went wrong");
                    }
                } catch (error) {
                    console.error("Error checking user existence:", error);
                    return { exists: false, notified: false };
                }
            }
            userExists = await checkUserExists(tweet.userId);
        }

        // Promise<"RESPOND" | "IGNORE" | "STOP" | null> {
        // if (shouldRespond !== "RESPOND") {
        //     elizaLogger.log("Not responding to message");
        //     return { text: "Response Decision:", action: shouldRespond };
        // }

        const context = composeContext({
            state,
            template:
                this.runtime.character.templates
                    ?.twitterMessageHandlerTemplate ||
                this.runtime.character?.templates?.messageHandlerTemplate ||
                tweet.isReply
                    ? twitterMessageHandlerTemplate +
                      `userRegistered=${userExists?.exists}`
                    : twitterMessageHandlerTemplate,
        });
        elizaLogger.debug("Interactions prompt:\n" + context);
        const response = await generateMessageResponse({
            runtime: this.runtime,
            context,
            modelClass: ModelClass.LARGE,
        });

        const assetDetails = response["details"] as {
            assetType: string;
            chainId: number;
            contractAddress: string;
            tokenId: string;
            tokenAmount: string;
            tokenSymbol: string;
        };

        const registerTweetRes = await fetch(
            "http://localhost:8080/agent/twitter/register-tweet",
            {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    twitterUserId: tweet.userId,
                    tweetId: tweet.id,
                    assetType: assetDetails.assetType,
                    chainId: assetDetails.chainId,
                    contractAddress: assetDetails.contractAddress,
                    nftId: assetDetails.tokenId,
                    tokenAmount: assetDetails.tokenAmount,
                    tokenSymbol: assetDetails.tokenSymbol,
                }),
            }
        );

        const data = await registerTweetRes.json();
        console.log({ data });

        const removeQuotes = (str: string) =>
            str.replace(/^['"](.*)['"]$/, "$1");

        const stringId = stringToUuid(tweet.id + "-" + this.runtime.agentId);

        response.inReplyTo = stringId;

        response.text = removeQuotes(response.text);

        if (response.text) {
            if (this.isDryRun) {
                elizaLogger.info(
                    `Dry run: Selected Post: ${tweet.id} - ${tweet.username}: ${tweet.text}\nAgent's Output:\n${response.text}`
                );
            } else {
                try {
                    const callback: HandlerCallback = async (
                        response: Content
                    ) => {
                        const memories = await sendTweet(
                            this.client,
                            response,
                            message.roomId,
                            this.client.twitterConfig.TWITTER_USERNAME,
                            tweet.id
                        );
                        return memories;
                    };

                    const responseMessages = await callback(response);

                    state = (await this.runtime.updateRecentMessageState(
                        state
                    )) as State;

                    for (const responseMessage of responseMessages) {
                        if (
                            responseMessage ===
                            responseMessages[responseMessages.length - 1]
                        ) {
                            responseMessage.content.action = response.action;
                        } else {
                            responseMessage.content.action = "CONTINUE";
                        }
                        await this.runtime.messageManager.createMemory(
                            responseMessage
                        );
                    }

                    await this.runtime.processActions(
                        message,
                        responseMessages,
                        state,
                        callback
                    );

                    const responseInfo = `Context:\n\n${context}\n\nSelected Post: ${tweet.id} - ${tweet.username}: ${tweet.text}\nAgent's Output:\n${response.text}`;

                    await this.runtime.cacheManager.set(
                        `twitter/tweet_generation_${tweet.id}.txt`,
                        responseInfo
                    );
                    await wait();
                } catch (error) {
                    elizaLogger.error(`Error sending response tweet: ${error}`);
                }
            }
        }
    }

    async buildConversationThread(
        tweet: Tweet,
        maxReplies: number = 10
    ): Promise<Tweet[]> {
        const thread: Tweet[] = [];
        const visited: Set<string> = new Set();

        async function processThread(currentTweet: Tweet, depth: number = 0) {
            elizaLogger.log("Processing tweet:", {
                id: currentTweet.id,
                inReplyToStatusId: currentTweet.inReplyToStatusId,
                depth: depth,
            });

            if (!currentTweet) {
                elizaLogger.log("No current tweet found for thread building");
                return;
            }

            if (depth >= maxReplies) {
                elizaLogger.log("Reached maximum reply depth", depth);
                return;
            }

            // Handle memory storage
            const memory = await this.runtime.messageManager.getMemoryById(
                stringToUuid(currentTweet.id + "-" + this.runtime.agentId)
            );
            if (!memory) {
                const roomId = stringToUuid(
                    currentTweet.conversationId + "-" + this.runtime.agentId
                );
                const userId = stringToUuid(currentTweet.userId);

                await this.runtime.ensureConnection(
                    userId,
                    roomId,
                    currentTweet.username,
                    currentTweet.name,
                    "twitter"
                );

                this.runtime.messageManager.createMemory({
                    id: stringToUuid(
                        currentTweet.id + "-" + this.runtime.agentId
                    ),
                    agentId: this.runtime.agentId,
                    content: {
                        text: currentTweet.text,
                        source: "twitter",
                        url: currentTweet.permanentUrl,
                        inReplyTo: currentTweet.inReplyToStatusId
                            ? stringToUuid(
                                  currentTweet.inReplyToStatusId +
                                      "-" +
                                      this.runtime.agentId
                              )
                            : undefined,
                    },
                    createdAt: currentTweet.timestamp * 1000,
                    roomId,
                    userId:
                        currentTweet.userId === this.twitterUserId
                            ? this.runtime.agentId
                            : stringToUuid(currentTweet.userId),
                    embedding: getEmbeddingZeroVector(),
                });
            }

            if (visited.has(currentTweet.id)) {
                elizaLogger.log("Already visited tweet:", currentTweet.id);
                return;
            }

            visited.add(currentTweet.id);
            thread.unshift(currentTweet);

            elizaLogger.debug("Current thread state:", {
                length: thread.length,
                currentDepth: depth,
                tweetId: currentTweet.id,
            });

            if (currentTweet.inReplyToStatusId) {
                elizaLogger.log(
                    "Fetching parent tweet:",
                    currentTweet.inReplyToStatusId
                );
                try {
                    const parentTweet = await this.twitterClient.getTweet(
                        currentTweet.inReplyToStatusId
                    );

                    if (parentTweet) {
                        elizaLogger.log("Found parent tweet:", {
                            id: parentTweet.id,
                            text: parentTweet.text?.slice(0, 50),
                        });
                        await processThread(parentTweet, depth + 1);
                    } else {
                        elizaLogger.log(
                            "No parent tweet found for:",
                            currentTweet.inReplyToStatusId
                        );
                    }
                } catch (error) {
                    elizaLogger.log("Error fetching parent tweet:", {
                        tweetId: currentTweet.inReplyToStatusId,
                        error,
                    });
                }
            } else {
                elizaLogger.log(
                    "Reached end of reply chain at:",
                    currentTweet.id
                );
            }
        }

        // Need to bind this context for the inner function
        await processThread.bind(this)(tweet, 0);

        elizaLogger.debug("Final thread built:", {
            totalTweets: thread.length,
            tweetIds: thread.map((t) => ({
                id: t.id,
                text: t.text?.slice(0, 50),
            })),
        });

        return thread;
    }
}
