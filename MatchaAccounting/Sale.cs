using System;

namespace MatchaAccounting
{
    // 销售数据模型
    public class Sale
    {
        public int Id { get; set; }
        public DateTime Date { get; set; }
        public decimal Total { get; set; }
    }
}