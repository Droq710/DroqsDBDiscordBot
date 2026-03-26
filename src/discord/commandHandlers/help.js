const { buildHelpEmbed } = require('../../utils/formatters');

async function execute(interaction, context) {
  await interaction.reply({
    embeds: [buildHelpEmbed({ webBaseUrl: context.config.droqsdbWebBaseUrl })]
  });
}

module.exports = {
  execute
};
