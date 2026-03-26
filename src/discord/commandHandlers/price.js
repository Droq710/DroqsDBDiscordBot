const { buildPriceEmbed } = require('../../utils/formatters');

async function execute(interaction, context) {
  const itemName = interaction.options.getString('item', true);
  await interaction.deferReply();

  const payload = await context.droqsdbClient.getItem(itemName);

  await interaction.editReply({
    embeds: [
      buildPriceEmbed({
        item: payload.item,
        generatedAt: payload.generatedAt,
        url: context.config.droqsdbWebBaseUrl
      })
    ]
  });
}

module.exports = {
  execute
};
