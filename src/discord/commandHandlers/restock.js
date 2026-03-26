const { buildInfoEmbed, buildRestockEmbed } = require('../../utils/formatters');

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

  const row = payload.countryRow;

  if (Number(row.stock) <= 0 && !Number.isFinite(Number(row.estimatedRestockMinutes))) {
    await interaction.editReply({
      embeds: [
        buildInfoEmbed(
          'No Public Restock Estimate',
          `${payload.item.itemName} is currently out of stock in ${payload.country}, but DroqsDB does not have a public restock estimate yet.`,
          { url: context.config.droqsdbWebBaseUrl }
        )
      ]
    });
    return;
  }

  await interaction.editReply({
    embeds: [
      buildRestockEmbed({
        item: payload.item,
        country: payload.country,
        row,
        generatedAt: payload.generatedAt,
        url: context.config.droqsdbWebBaseUrl
      })
    ]
  });
}

module.exports = {
  execute
};
