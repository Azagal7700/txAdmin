const modulename = 'DiscordBot:interactionHandler';
import { Interaction } from 'discord.js';
import TxAdmin from '@core/txAdmin.js';
import logger, { ogConsole } from '@core/extras/console.js';
import infoCommandHandler from './commands/info';
import statusCommandHandler from './commands/status';
import whitelistCommandHandler from './commands/whitelist';
import { embedder } from './discordHelpers';
import { cloneDeep } from 'lodash-es'; //DEBUG
const { dir, log, logOk, logWarn, logError, logDebug } = logger(modulename);


//All commands
const handlers = {
    status: statusCommandHandler,
    whitelist: whitelistCommandHandler,
    info: infoCommandHandler,
}

const noHandlerResponse = async (interaction: Interaction) => {
    if (interaction.isRepliable()) {
        //@ts-ignore
        const identifier = interaction?.commandName ?? interaction?.customId;
        await interaction.reply({
            content: `No handler available for this interaction (${interaction.type} > ${identifier})`,
            ephemeral: true,
        });
    }
}


export default async (txAdmin: TxAdmin, interaction: Interaction) => {
    //Handler filter
    if (interaction.user.bot) return;

    //DEBUG
    // const copy = Object.assign(cloneDeep(interaction), { user: false, member: false });
    // ogConsole.dir(copy)

    //Process buttons
    if (interaction.isButton()) {
        // //Get interaction
        // const [iid, ...args] = interaction.customId.split(':');
        // const handler = txChungus.interactionsManager.cache.get(`button:${iid}`);
        // if (!handler) {
        //     logError(`No handler available for button interaction ${interaction.customId}`);
        //     return;
        // }
        // //Executes interaction
        // try {
        //     return await handler.execute(interaction, args, txChungus);
        // } catch (error) {
        //     return await logError(`Error executing ${interaction.customId}: ${error.message}`);
        // }
    }

    //Process Slash commands
    if (interaction.isCommand()) {
        //Get interaction
        const handler = handlers[interaction.commandName as keyof typeof handlers];
        if (!handler) {
            noHandlerResponse(interaction).catch();
            return;
        }

        //Executes interaction
        try {
            await handler(interaction, txAdmin);
            return;
        } catch (error) {
            const msg = `Error executing ${interaction.commandName}: ${(error as Error).message}`;
            logError(msg);
            return await interaction.reply(embedder.danger(msg, true));
        }
    }

    //Unknown type
    noHandlerResponse(interaction).catch();
};