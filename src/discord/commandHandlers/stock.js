const { buildInfoEmbed, buildStockEmbed } = require('../../utils/formatters');

async function execute(interaction, context) {
  const itemName = interaction.options.getString('item', true);
  const country = interaction.options.getString('country', true);
  await interaction.deferReply();

  const payload = await context.droqsdbClient.getItemCountrySnapshot(itemName, country);

  if (!payload.countryRow) {
    await interaction.editReply({
      embeds: [
        buildInfoEmbed(
          'Item Not Sold There',
          `${payload.item.itemName} is not currently tracked in ${payload.country}.`,
          { url: context.config.droqsdbWebBaseUrl }
        )
      ]
    });
    return;
  }

  await interaction.editReply({
    embeds: [
      buildStockEmbed({
        item: payload.item,
        country: payload.country,
        row: payload.countryRow,
        generatedAt: payload.generatedAt,
        url: context.config.droqsdbWebBaseUrl
      })
    ]
  });
}

module.exports = {
  execute
};
