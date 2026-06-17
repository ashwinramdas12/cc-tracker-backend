export const formatMonthYear = (dateInput) => {
    const months = ["January","February","March","April","May","June",
                    "July","August","September","October","November","December"];
    const date = new Date(dateInput);
    return `${months[date.getMonth()]} ${date.getFullYear()}`;
  }